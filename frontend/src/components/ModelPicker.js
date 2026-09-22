import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { MODEL_OPTIONS } from '../utils/assistant';

// Which LLM answers the next turn. A pill button showing the current pick,
// opening a small menu of the three configured providers — the interaction
// Claude/ChatGPT-style chat UIs use, applied to Sentinel's own popover
// styling (see .as-conv-menu, the session kebab menu, for the pattern this
// borrows).
export default function ModelPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  // Which row the gliding highlight sits under — the hovered row, falling
  // back to the currently-selected model once the pointer leaves the menu.
  const [hovered, setHovered] = useState(null);
  const [box, setBox] = useState(null);
  const wrapRef = useRef(null);
  const itemRefs = useRef([]);

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

  useEffect(() => {
    if (!open) setHovered(null);
  }, [open]);

  const current = MODEL_OPTIONS.find((m) => m.key === value) || MODEL_OPTIONS[0];
  const selectedIdx = MODEL_OPTIONS.findIndex((m) => m.key === value);

  useLayoutEffect(() => {
    if (!open) return;
    const el = itemRefs.current[hovered ?? selectedIdx];
    if (el) setBox({ top: el.offsetTop, height: el.offsetHeight });
  }, [open, hovered, selectedIdx]);

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
        {current.label}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="as-model-menu" role="listbox" aria-label="Model" onMouseLeave={() => setHovered(null)}>
          <span
            aria-hidden="true"
            className="as-model-highlight"
            style={{ top: box?.top ?? 0, height: box?.height ?? 0, opacity: box ? 1 : 0 }}
          />
          {MODEL_OPTIONS.map((m, i) => (
            <button
              key={m.key}
              type="button"
              role="option"
              aria-selected={m.key === value}
              className="as-model-item"
              ref={(el) => { itemRefs.current[i] = el; }}
              onMouseEnter={() => setHovered(i)}
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
