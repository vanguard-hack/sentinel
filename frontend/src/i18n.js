import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en/translation.json';
import hi from './locales/hi/translation.json';
import kn from './locales/kn/translation.json';

// English, Hindi and Kannada. The choice persists per browser and is sent with
// every assistant request as `preferred_lang`, so the reply comes back in the
// same language the interface is in.
export const LANGUAGES = [
  { code: 'en', label: 'English', native: 'English', short: 'EN' },
  { code: 'hi', label: 'हिन्दी (Hindi)', native: 'हिन्दी', short: 'हिं' },
  { code: 'kn', label: 'ಕನ್ನಡ (Kannada)', native: 'ಕನ್ನಡ', short: 'ಕನ' },
];

export const LANG_CODES = LANGUAGES.map((l) => l.code);
const STORAGE_KEY = 'sentinel-lang';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      hi: { translation: hi },
      kn: { translation: kn },
    },
    supportedLngs: LANG_CODES,
    fallbackLng: 'en',
    // A browser set to hi-IN should get Hindi, not fall through to English.
    load: 'languageOnly',
    nonExplicitSupportedLngs: true,
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: STORAGE_KEY,
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false }, // React already escapes
  });

// Script per language, so the right font stack and line height apply.
const SCRIPT = { en: 'latin', hi: 'deva', kn: 'knda' };

function applyLangAttributes(lng) {
  const code = LANG_CODES.includes(lng) ? lng : 'en';
  // No document outside a browser (a Node-environment test, or any future
  // server-side render) — the attributes are purely presentational, so there
  // is nothing to do rather than anything to fail over.
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('lang', code);
  root.setAttribute('data-script', SCRIPT[code] || 'latin');
  // All three scripts are left-to-right; set it explicitly so a future RTL
  // language only needs this one line changed.
  root.setAttribute('dir', 'ltr');
}

applyLangAttributes(i18n.resolvedLanguage || i18n.language);
i18n.on('languageChanged', applyLangAttributes);

export const currentLang = () => (LANG_CODES.includes(i18n.resolvedLanguage) ? i18n.resolvedLanguage : 'en');

export default i18n;
