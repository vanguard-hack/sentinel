import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { VOICE_LANG_OPTIONS as OPTIONS } from '../utils/assistant';

// Which language the mic listens for. Deliberately independent of the
// platform's display language (Settings → language toggle): an officer whose
// UI is in English still needs to dictate a Hindi or Kannada sentence without
// switching the whole console. Getting this wrong is silent and ugly — a
// Hindi sentence forced through an English recognizer comes back as
// "han bhai mera naam..." (real words, phonetically mangled into Latin
// letters), not an error, so there is nothing else to catch it.

export default function VoiceLangPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = OPTIONS.find((o) => o.key === value) || OPTIONS[0];

  return (
    <div className="as-model-wrap" ref={wrapRef}>
      <button
        type="button"
        className="as-model-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={`Voice input language: ${current.label} — click to change`}
      >
        {current.label}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="as-model-menu" role="listbox" aria-label="Voice input language">
          {OPTIONS.map((o) => (
            <button
              key={o.key}
              type="button"
              role="option"
              aria-selected={o.key === value}
              className="as-model-item"
              onClick={() => { onChange(o.key); setOpen(false); }}
            >
              <span className="as-model-item-text">
                <span className="as-model-item-label">{o.label}</span>
              </span>
              {o.key === value && <Check size={14} className="as-model-item-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
