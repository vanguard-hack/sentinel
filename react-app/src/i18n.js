import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en/translation.json';
import hi from './locales/hi/translation.json';
import kn from './locales/kn/translation.json';

// Languages offered in the UI switcher. `label` is the short glyph shown on the
// toggle; add a new entry + locale file to support another language.
export const LANGUAGES = [
  { code: 'en', label: 'EN', name: 'English' },
  { code: 'hi', label: 'हि', name: 'हिन्दी' },
  { code: 'kn', label: 'ಕ', name: 'ಕನ್ನಡ' },
];

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      hi: { translation: hi },
      kn: { translation: kn },
    },
    fallbackLng: 'en',
    supportedLngs: LANGUAGES.map((l) => l.code),
    // English is the default on first visit; the user's pick is then remembered.
    detection: {
      order: ['localStorage'],
      lookupLocalStorage: 'sentinel-lang',
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false }, // React already escapes
  });

export default i18n;
