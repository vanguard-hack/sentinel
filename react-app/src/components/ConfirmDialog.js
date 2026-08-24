// App-wide confirmation dialog — replaces the browser's native window.confirm,
// which cannot be styled and looks foreign inside the app.
//
// Usage:
//   const confirm = useConfirm();
//   if (!(await confirm({ title: 'Remove this page?', body: '…', tone: 'danger' }))) return;
//
// The hook returns a promise resolving true/false, so call sites read almost
// exactly like the window.confirm they replace.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, HelpCircle, Trash2, X } from 'lucide-react';

const ConfirmContext = createContext(null);

const TONE_ICONS = { danger: Trash2, warning: AlertTriangle, default: HelpCircle };

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null); // { opts, resolve }
  const okRef = useRef(null);

  const confirm = useCallback((opts) => new Promise((resolve) => {
    setState({ opts: typeof opts === 'string' ? { title: opts } : (opts || {}), resolve });
  }), []);

  const close = useCallback((result) => {
    setState((s) => {
      if (s) s.resolve(result);
      return null;
    });
  }, []);

  // Focus the confirm button on open so Enter/Escape work immediately.
  useEffect(() => {
    if (!state) return undefined;
    const t = setTimeout(() => okRef.current?.focus(), 30);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
    };
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey); };
  }, [state, close]);

  const value = useMemo(() => confirm, [confirm]);

  const opts = state?.opts || {};
  const tone = opts.tone || 'default';
  const Icon = TONE_ICONS[tone] || TONE_ICONS.default;

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {state && (
        <div className="cd-scrim" onMouseDown={() => close(false)}>
          <div
            className={`cd-modal ${tone}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cd-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button type="button" className="cd-x" aria-label="Close" onClick={() => close(false)}>
              <X size={16} />
            </button>
            <div className="cd-icon"><Icon size={20} strokeWidth={2} /></div>
            <h3 id="cd-title" className="cd-title">{opts.title || 'Are you sure?'}</h3>
            {opts.body && <p className="cd-body">{opts.body}</p>}
            <div className="cd-actions">
              <button type="button" className="cd-btn ghost" onClick={() => close(false)}>
                {opts.cancelLabel || 'Cancel'}
              </button>
              <button ref={okRef} type="button" className={`cd-btn solid ${tone}`} onClick={() => close(true)}>
                {opts.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    // Provider missing (shouldn't happen) — degrade to the native dialog
    // rather than silently dropping a destructive-action guard.
    return (opts) => Promise.resolve(
      // eslint-disable-next-line no-alert
      window.confirm(typeof opts === 'string' ? opts : `${opts?.title || 'Are you sure?'}${opts?.body ? `\n\n${opts.body}` : ''}`)
    );
  }
  return ctx;
}
