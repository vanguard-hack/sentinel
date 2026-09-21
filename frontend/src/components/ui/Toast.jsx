import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, AlertTriangle, Info, Loader2, X } from 'lucide-react';
import './Toast.css';

const ToastContext = createContext(null);

const TONE_ICON = { success: CheckCircle2, error: AlertTriangle, info: Info, loading: Loader2 };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const show = useCallback((message, { tone = 'info', duration = 4000 } = {}) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, message, tone }]);
    if (duration > 0) setTimeout(() => dismiss(id), duration);
    return id;
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      <div className="ui-toast-stack" aria-live="polite">
        <AnimatePresence>
          {toasts.map((toast) => {
            const Icon = TONE_ICON[toast.tone] || Info;
            return (
              <motion.div
                key={toast.id}
                role="status"
                data-tone={toast.tone}
                className="ui-toast"
                layout
                initial={{ opacity: 0, y: 12, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 80 }}
                drag="x"
                dragConstraints={{ left: 0, right: 0 }}
                onDragEnd={(_, info) => { if (Math.abs(info.offset.x) > 80) dismiss(toast.id); }}
              >
                <Icon size={16} className={toast.tone === 'loading' ? 'ui-toast-spin' : undefined} />
                <span>{toast.message}</span>
                <button aria-label="Dismiss" onClick={() => dismiss(toast.id)}><X size={14} /></button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast() must be used inside <ToastProvider>');
  return ctx;
}
