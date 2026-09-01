'use strict';

/**
 * Officer-facing strings the server writes itself, in the three languages
 * Sentinel supports.
 *
 * WHY THESE ARE A TABLE AND NOT A TRANSLATION CALL
 *
 * The assistant's ANSWER is generated in English and re-expressed in the
 * officer's language by a model, because its content is different every time
 * and no table could hold it. Everything in this file is the opposite: fixed
 * text the server emits verbatim — a notice that identity was withheld, a
 * warning that an identifier could not be verified, the title above a table.
 *
 * Sending those through a model would be three things at once: slower (a round
 * trip per notice), worse (a fixed legal sentence re-translated slightly
 * differently on every request), and unreliable (a provider outage silently
 * reverting to English at the moment a warning matters most). They are written
 * once, checked once, and served from memory.
 *
 * WHAT IS DELIBERATELY LEFT IN ENGLISH
 *
 * Identifiers. Crime numbers, section citations, vehicle plates, database
 * column names. A column headed CrimeNo is not an English word that happens to
 * appear in a table, it is the name of a field, and translating it would break
 * the officer's ability to match what they see against the record system they
 * already use. Where a template interpolates one of these, it stays exactly as
 * it arrived.
 */

const LANGS = ['en', 'hi', 'kn'];
const fallback = 'en';

// Templates use {name} placeholders. Kept literal rather than positional so a
// translator can reorder them — Kannada and Hindi both put the object before
// the verb, and a positional %s would force a wrong word order.
const STRINGS = {
  // ── Protected identity ───────────────────────────────────────────────────
  'protected.blocked': {
    en: 'Victim and complainant identity on offences against women and children is restricted to '
      + 'investigators and above. The case details above are complete in every other respect.',
    hi: 'महिलाओं और बच्चों के विरुद्ध अपराधों में पीड़ित तथा शिकायतकर्ता की पहचान केवल विवेचक और उससे '
      + 'वरिष्ठ अधिकारियों तक सीमित है। ऊपर दिए गए प्रकरण के शेष सभी विवरण पूर्ण हैं।',
    kn: 'ಮಹಿಳೆಯರು ಮತ್ತು ಮಕ್ಕಳ ವಿರುದ್ಧದ ಅಪರಾಧಗಳಲ್ಲಿ ಸಂತ್ರಸ್ತರ ಮತ್ತು ದೂರುದಾರರ ಗುರುತು ತನಿಖಾಧಿಕಾರಿ ಮತ್ತು '
      + 'ಅದಕ್ಕಿಂತ ಮೇಲಿನ ಅಧಿಕಾರಿಗಳಿಗೆ ಮಾತ್ರ ಸೀಮಿತವಾಗಿದೆ. ಮೇಲಿನ ಪ್ರಕರಣದ ಉಳಿದ ಎಲ್ಲ ವಿವರಗಳು ಪೂರ್ಣವಾಗಿವೆ.',
  },
  'protected.unlockable': {
    en: 'Victim and complainant identity is withheld on offences against women and children '
      + '(BNS s.72, POCSO s.23). Ask again stating why you need it for this case — the name will '
      + 'be released and your reason recorded in the audit trail against your badge.',
    hi: 'महिलाओं और बच्चों के विरुद्ध अपराधों में पीड़ित तथा शिकायतकर्ता की पहचान रोकी गई है '
      + '(BNS s.72, POCSO s.23)। इस प्रकरण के लिए आपको यह क्यों चाहिए, यह बताते हुए पुनः पूछें — नाम '
      + 'जारी किया जाएगा और आपका कारण आपके बैज के विरुद्ध अंकेक्षण अभिलेख में दर्ज होगा।',
    kn: 'ಮಹಿಳೆಯರು ಮತ್ತು ಮಕ್ಕಳ ವಿರುದ್ಧದ ಅಪರಾಧಗಳಲ್ಲಿ ಸಂತ್ರಸ್ತರ ಮತ್ತು ದೂರುದಾರರ ಗುರುತನ್ನು ತಡೆಹಿಡಿಯಲಾಗಿದೆ '
      + '(BNS s.72, POCSO s.23). ಈ ಪ್ರಕರಣಕ್ಕೆ ಅದು ನಿಮಗೆ ಏಕೆ ಬೇಕು ಎಂಬುದನ್ನು ತಿಳಿಸಿ ಮತ್ತೊಮ್ಮೆ ಕೇಳಿ — '
      + 'ಹೆಸರು ಬಿಡುಗಡೆಯಾಗುತ್ತದೆ ಮತ್ತು ನಿಮ್ಮ ಕಾರಣವು ನಿಮ್ಮ ಬ್ಯಾಡ್ಜ್‌ನ ವಿರುದ್ಧ ಲೆಕ್ಕಪರಿಶೋಧನಾ ದಾಖಲೆಯಲ್ಲಿ ದಾಖಲಾಗುತ್ತದೆ.',
  },

  // ── Grounding ────────────────────────────────────────────────────────────
  // {ids} is a list of identifiers and is never translated.
  'grounding.unsupported.one': {
    en: '{ids} does not appear in any record retrieved for this answer — treat it as unverified.',
    hi: '{ids} इस उत्तर के लिए प्राप्त किसी भी अभिलेख में नहीं मिलता — इसे असत्यापित मानें।',
    kn: '{ids} ಈ ಉತ್ತರಕ್ಕಾಗಿ ಪಡೆದ ಯಾವುದೇ ದಾಖಲೆಯಲ್ಲಿ ಕಂಡುಬರುವುದಿಲ್ಲ — ಇದನ್ನು ಪರಿಶೀಲಿಸದ್ದೆಂದು ಪರಿಗಣಿಸಿ.',
  },
  'grounding.unsupported.many': {
    en: '{ids} do not appear in any record retrieved for this answer — treat them as unverified.',
    hi: '{ids} इस उत्तर के लिए प्राप्त किसी भी अभिलेख में नहीं मिलते — इन्हें असत्यापित मानें।',
    kn: '{ids} ಈ ಉತ್ತರಕ್ಕಾಗಿ ಪಡೆದ ಯಾವುದೇ ದಾಖಲೆಯಲ್ಲಿ ಕಂಡುಬರುವುದಿಲ್ಲ — ಇವುಗಳನ್ನು ಪರಿಶೀಲಿಸದ್ದೆಂದು ಪರಿಗಣಿಸಿ.',
  },
  'grounding.sections.one': {
    en: "{ids} is outside Sentinel's legal reference — check the bare Act before relying on it.",
    hi: '{ids} Sentinel के विधिक संदर्भ के बाहर है — इस पर निर्भर होने से पहले मूल अधिनियम देखें।',
    kn: '{ids} Sentinel ನ ಕಾನೂನು ಉಲ್ಲೇಖದ ಹೊರಗಿದೆ — ಇದನ್ನು ಅವಲಂಬಿಸುವ ಮೊದಲು ಮೂಲ ಕಾಯ್ದೆಯನ್ನು ಪರಿಶೀಲಿಸಿ.',
  },
  'grounding.sections.many': {
    en: "{ids} are outside Sentinel's legal reference — check the bare Act before relying on them.",
    hi: '{ids} Sentinel के विधिक संदर्भ के बाहर हैं — इन पर निर्भर होने से पहले मूल अधिनियम देखें।',
    kn: '{ids} Sentinel ನ ಕಾನೂನು ಉಲ್ಲೇಖದ ಹೊರಗಿವೆ — ಇವುಗಳನ್ನು ಅವಲಂಬಿಸುವ ಮೊದಲು ಮೂಲ ಕಾಯ್ದೆಯನ್ನು ಪರಿಶೀಲಿಸಿ.',
  },

  'grounding.contradiction.one': {
    en: 'This answer reports nothing on file, but {rows} record was retrieved — open the sources '
      + 'below before accepting it.',
    hi: 'यह उत्तर कहता है कि अभिलेख में कुछ नहीं है, किंतु {rows} अभिलेख प्राप्त हुआ था — इसे स्वीकार '
      + 'करने से पहले नीचे दिए स्रोत देखें।',
    kn: 'ಈ ಉತ್ತರವು ದಾಖಲೆಯಲ್ಲಿ ಏನೂ ಇಲ್ಲವೆಂದು ಹೇಳುತ್ತದೆ, ಆದರೆ {rows} ದಾಖಲೆ ದೊರೆತಿತ್ತು — ಇದನ್ನು '
      + 'ಒಪ್ಪುವ ಮೊದಲು ಕೆಳಗಿನ ಮೂಲಗಳನ್ನು ನೋಡಿ.',
  },
  'grounding.contradiction.many': {
    en: 'This answer reports nothing on file, but {rows} records were retrieved — open the sources '
      + 'below before accepting it.',
    hi: 'यह उत्तर कहता है कि अभिलेख में कुछ नहीं है, किंतु {rows} अभिलेख प्राप्त हुए थे — इसे स्वीकार '
      + 'करने से पहले नीचे दिए स्रोत देखें।',
    kn: 'ಈ ಉತ್ತರವು ದಾಖಲೆಯಲ್ಲಿ ಏನೂ ಇಲ್ಲವೆಂದು ಹೇಳುತ್ತದೆ, ಆದರೆ {rows} ದಾಖಲೆಗಳು ದೊರೆತಿದ್ದವು — ಇದನ್ನು '
      + 'ಒಪ್ಪುವ ಮೊದಲು ಕೆಳಗಿನ ಮೂಲಗಳನ್ನು ನೋಡಿ.',
  },

  // ── Attachments ──────────────────────────────────────────────────────────
  'attachment.injection': {
    en: 'The attached file contains text written to look like an instruction to this assistant. '
      + 'It was read as document content and nothing in it was obeyed — but a document written '
      + 'that way is worth treating as suspect.',
    hi: 'संलग्न फ़ाइल में ऐसा पाठ है जो इस सहायक को दिए गए निर्देश जैसा दिखने के लिए लिखा गया है। '
      + 'उसे दस्तावेज़ की सामग्री के रूप में पढ़ा गया और उसमें से किसी बात का पालन नहीं किया गया — '
      + 'किंतु इस प्रकार लिखे गए दस्तावेज़ को संदिग्ध मानना उचित है।',
    kn: 'ಲಗತ್ತಿಸಲಾದ ಕಡತದಲ್ಲಿ ಈ ಸಹಾಯಕನಿಗೆ ನೀಡಿದ ಸೂಚನೆಯಂತೆ ಕಾಣುವಂತೆ ಬರೆದ ಪಠ್ಯವಿದೆ. ಅದನ್ನು ದಾಖಲೆಯ '
      + 'ವಿಷಯವಾಗಿ ಓದಲಾಗಿದೆ ಮತ್ತು ಅದರಲ್ಲಿ ಯಾವುದನ್ನೂ ಪಾಲಿಸಲಾಗಿಲ್ಲ — ಆದರೆ ಹೀಗೆ ಬರೆದ ದಾಖಲೆಯನ್ನು '
      + 'ಸಂಶಯಾಸ್ಪದವೆಂದು ಪರಿಗಣಿಸುವುದು ಸೂಕ್ತ.',
  },

  // ── Components ───────────────────────────────────────────────────────────
  // {column} is a database column name and is deliberately NOT translated: a
  // heading an officer can match against the field they know is worth more
  // than one that reads smoothly and corresponds to nothing.
  'component.byDistrict': {
    en: '{column} by district',
    hi: 'ज़िलेवार {column}',
    kn: 'ಜಿಲ್ಲಾವಾರು {column}',
  },
  'component.districtFigures': {
    en: 'District figures',
    hi: 'ज़िलेवार आँकड़े',
    kn: 'ಜಿಲ್ಲಾವಾರು ಅಂಕಿಅಂಶಗಳು',
  },

  // ── Refusals ─────────────────────────────────────────────────────────────
  'guard.refusal': {
    en: 'I can only answer from the case records — I cannot share my own instructions or '
      + 'configuration. Ask me about cases, sections or deadlines and I will help.',
    hi: 'मैं केवल प्रकरण अभिलेखों के आधार पर उत्तर दे सकता हूँ — अपने निर्देश या संरचना साझा नहीं कर सकता। '
      + 'प्रकरणों, धाराओं या समय-सीमाओं के बारे में पूछें, मैं सहायता करूँगा।',
    kn: 'ನಾನು ಪ್ರಕರಣ ದಾಖಲೆಗಳಿಂದ ಮಾತ್ರ ಉತ್ತರಿಸಬಲ್ಲೆ — ನನ್ನ ಸ್ವಂತ ಸೂಚನೆಗಳನ್ನು ಅಥವಾ ಸಂರಚನೆಯನ್ನು '
      + 'ಹಂಚಿಕೊಳ್ಳಲಾರೆ. ಪ್ರಕರಣಗಳು, ಸೆಕ್ಷನ್‌ಗಳು ಅಥವಾ ಗಡುವುಗಳ ಬಗ್ಗೆ ಕೇಳಿ, ನಾನು ಸಹಾಯ ಮಾಡುತ್ತೇನೆ.',
  },
};

/**
 * One string in one language.
 *
 * Falls back to English for an unknown language or an untranslated key rather
 * than returning the key itself: an officer reading a slightly foreign sentence
 * has been informed, and one reading "protected.blocked" has not.
 */
function t(key, lang, vars) {
  const entry = STRINGS[key];
  if (!entry) return '';
  const text = entry[LANGS.includes(lang) ? lang : fallback] || entry[fallback] || '';
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) =>
    (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
}

/** Every key, for the completeness test. */
const keys = () => Object.keys(STRINGS);

module.exports = { t, keys, LANGS, STRINGS };
