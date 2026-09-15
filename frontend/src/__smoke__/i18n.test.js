/* Language support: detection thresholds, switcher persistence, script attrs. */
import i18n, { LANGUAGES, LANG_CODES, currentLang } from '../i18n';

// Mirrors detectLang() in functions/rag/index.js. Kept here as executable
// documentation of the rule the backend relies on: Indic script is decisive,
// Latin script is not evidence of English.
function detectLang(text, preferred) {
  const s = String(text || '');
  const deva = (s.match(/[\u0900-\u097F]/g) || []).length;
  const knda = (s.match(/[\u0C80-\u0CFF]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  const indic = deva + knda;
  const total = indic + latin;
  const pref = LANG_CODES.includes(preferred) ? preferred : 'en';
  if (!total) return { lang: pref, confidence: 0 };
  if (indic > 0) {
    const lang = deva >= knda ? 'hi' : 'kn';
    const confidence = Math.max(deva, knda) / total;
    if (confidence >= 0.35) return { lang, confidence };
    return { lang: pref, confidence, mixed: true };
  }
  return { lang: pref, confidence: 1, mixed: pref !== 'en' };
}

test('Devanagari and Kannada are identified from script alone', () => {
  expect(detectLang('एफआईआर संख्या क्या है', 'en').lang).toBe('hi');
  expect(detectLang('ಎಫ್‌ಐಆರ್ ಸಂಖ್ಯೆ ಏನು', 'en').lang).toBe('kn');
  expect(detectLang('What is the FIR number', 'en').lang).toBe('en');
});

test('code-mixed text falls back to the language the officer selected', () => {
  // "Hinglish" is Latin script, so treating Latin as English would wrongly
  // answer an officer working in Hindi in English.
  const mixed = detectLang('FIR 4029 ka vehicle seizure detail dijiye', 'hi');
  expect(mixed.lang).toBe('hi');
  // …but an English speaker typing English still gets English.
  expect(detectLang('Give me the vehicle seizure details', 'en').lang).toBe('en');
  // A genuine identifier-heavy Kannada query still resolves to Kannada.
  const kn = detectLang('ಎಫ್‌ಐಆರ್ 4029 ರ ವಿವರ', 'en');
  expect(kn.lang).toBe('kn');
});

test('identifiers alone do not flip the language', () => {
  // A registration number carries no linguistic signal; it must not switch an
  // officer out of the language they selected.
  expect(detectLang('KA01AB1234', 'kn').lang).toBe('kn');
  expect(detectLang('', 'hi').lang).toBe('hi');
  expect(detectLang('FIR #4029', 'hi').lang).toBe('hi');
});

test('a Kannada question peppered with Latin identifiers stays Kannada', () => {
  const q = 'ಎಫ್‌ಐಆರ್ 4029 ರ ಪ್ರಕಾರ KA01AB1234 ವಾಹನ ಜಪ್ತಿ ವಿವರ';
  expect(detectLang(q, 'en').lang).toBe('kn');
});

test('all three languages are registered with real translations', () => {
  expect(LANGUAGES.map((l) => l.code)).toEqual(['en', 'hi', 'kn']);
  expect(i18n.getResource('hi', 'translation', 'modules.assistant.label')).toBeTruthy();
  expect(i18n.getResource('kn', 'translation', 'modules.assistant.label')).toBeTruthy();
  // and they differ from English, i.e. they are actually translated
  expect(i18n.getResource('hi', 'translation', 'modules.assistant.label'))
    .not.toBe(i18n.getResource('en', 'translation', 'modules.assistant.label'));
});

test('switching language sets the script attribute for font selection', async () => {
  await i18n.changeLanguage('kn');
  expect(document.documentElement.getAttribute('data-script')).toBe('knda');
  expect(currentLang()).toBe('kn');
  await i18n.changeLanguage('hi');
  expect(document.documentElement.getAttribute('data-script')).toBe('deva');
  await i18n.changeLanguage('en');
  expect(document.documentElement.getAttribute('data-script')).toBe('latin');
  expect(document.documentElement.getAttribute('dir')).toBe('ltr');
});

test('Hindi and Kannada cover every English key, with no English left behind', () => {
  const flatten = (o, prefix = '') => Object.entries(o).reduce((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' ? { ...acc, ...flatten(v, key) } : { ...acc, [key]: v };
  }, {});

  const en = flatten(i18n.getResourceBundle('en', 'translation'));
  const hi = flatten(i18n.getResourceBundle('hi', 'translation'));
  const kn = flatten(i18n.getResourceBundle('kn', 'translation'));

  const missingHi = Object.keys(en).filter((k) => !(k in hi));
  const missingKn = Object.keys(en).filter((k) => !(k in kn));
  expect(missingHi).toEqual([]);
  expect(missingKn).toEqual([]);

  // A value identical to English usually means an untranslated string was
  // copied across. Identifiers and format names legitimately stay Latin, so
  // only flag entries with real prose.
  const suspicious = (dict) => Object.keys(en).filter((k) => {
    const a = String(en[k] || '');
    const b = String(dict[k] || '');
    return a === b && /\s/.test(a) && a.length > 12;
  });
  expect(suspicious(hi)).toEqual([]);
  expect(suspicious(kn)).toEqual([]);
});
