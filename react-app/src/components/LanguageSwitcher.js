import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Globe } from 'lucide-react';
import { LANGUAGES, currentLang } from '../i18n';
import { logAudit } from '../utils/audit';

// Language switcher. The choice persists in localStorage (see i18n.js) and is
// attached to every assistant request, so the interface and the answers stay in
// the same language.
export default function LanguageSwitcher({ collapsed }) {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const active = currentLang();
  const activeLang = LANGUAGES.find((l) => l.code === active) || LANGUAGES[0];

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (code) => {
    i18n.changeLanguage(code);
    setOpen(false);
    logAudit('language-change', 'Settings', code);
  };

  return (
    <div className="sb-lang" ref={ref}>
      <button
        type="button"
        className={`sb-lang-btn ${open ? 'open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={t('a11y.language', 'Language')}
        aria-label={t('a11y.language', 'Language')}
        aria-expanded={open}
      >
        <Globe size={17} strokeWidth={1.8} />
        {!collapsed && <span className="sb-lang-name">{activeLang.native}</span>}
      </button>
      {open && (
        <div className="sb-lang-menu" role="menu">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              className={l.code === active ? 'active' : ''}
              onClick={() => pick(l.code)}
              role="menuitemradio"
              aria-checked={l.code === active}
              lang={l.code}
            >
              <span>{l.native}</span>
              <span className="sb-lang-en">{l.label}</span>
              {l.code === active && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
