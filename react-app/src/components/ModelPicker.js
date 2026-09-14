import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { MODEL_OPTIONS } from '../utils/assistant';

// Which LLM answers the next turn. A pill button showing the current pick,
// opening a small menu of the three configured providers — the interaction
// Claude/ChatGPT-style chat UIs use, applied to Sentinel's own popover
// styling (see .as-conv-menu, the session kebab menu, for the pattern this
// borrows).
export default function ModelPicker({ value, onChange }) {
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

  const current = MODEL_OPTIONS.find((m) => m.key === value) || MODEL_OPTIONS[0];

  return (
    <div className="as-model-wrap" ref={wrapRef}>
      <button
        type="button"
        className="as-model-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={`Model: ${current.label} — click to change`}
      >
        Model
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="as-model-menu" role="listbox" aria-label="Model">
          {MODEL_OPTIONS.map((m) => (
            <button
              key={m.key}
              type="button"
              role="option"
              aria-selected={m.key === value}
              className="as-model-item"
              onClick={() => { onChange(m.key); setOpen(false); }}
            >
              <span className="as-model-item-text">
                <span className="as-model-item-label">{m.label}</span>
                <span className="as-model-item-desc">{m.desc}</span>
              </span>
              {m.key === value && <Check size={14} className="as-model-item-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
