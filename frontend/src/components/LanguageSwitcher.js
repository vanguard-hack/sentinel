import React from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, currentLang } from '../i18n';
import { logAudit } from '../utils/audit';

// A segmented control rather than a dropdown: with only three options, showing
// all of them costs one row and removes a click plus the guesswork of "what is
// this set to?". Each is labelled in its own script — EN / हिं / ಕನ್ನ — so an
// officer who cannot read the current language can still find their own, which
// a dropdown collapsed to the active value defeats.
export default function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const active = currentLang();

  const pick = (code) => {
    if (code === active) return;
    i18n.changeLanguage(code);
    logAudit('language-change', 'Settings', code);
  };

  return (
    <div
      className="lang-seg"
      role="radiogroup"
      aria-label={t('a11y.language', 'Change language')}
    >
      {LANGUAGES.map((l) => (
        <button
          key={l.code}
          type="button"
          role="radio"
          aria-checked={l.code === active}
          className={l.code === active ? 'active' : ''}
          onClick={() => pick(l.code)}
          title={l.label}
          lang={l.code}
        >
          {l.short}
        </button>
      ))}
    </div>
  );
}
