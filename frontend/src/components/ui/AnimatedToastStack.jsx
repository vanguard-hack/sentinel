// frontend/src/components/ui/AnimatedToastStack.jsx
//
// Ported from ui.spectrumhq.in's public shadcn registry endpoint
// (https://ui.spectrumhq.in/r/toast-stack.json — no login needed, unlike the
// site's own "view code" tab; the file itself is a republish of
// beui.dev/components/motion/animated-toast-stack, per its own header
// comment). Same component, same API (AnimatedToastStack,
// useAnimatedToastStack, showToast/updateToast/dismissToast, status morphs,
// swipe-to-dismiss) — TypeScript types dropped, Tailwind utility classes
// translated to this app's plain-CSS tokens, `cn()`/clsx/tailwind-merge
// dropped in favor of plain className joins (this app has no Tailwind).
import { AlertCircle, Bell, Check, Info, LoaderCircle, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './AnimatedToastStack.css';

const EASE_OUT = [0.16, 1, 0.3, 1];

const STACK_SPRING = { type: 'spring', stiffness: 420, damping: 34, mass: 0.75 };
const CONTENT_TRANSITION = { duration: 0.28, ease: EASE_OUT };

const STATUS_ICON = { neutral: Bell, info: Info, loading: LoaderCircle, success: Check, error: AlertCircle };
const STATUS_CLASS = {
  neutral: 'ui-toast-icon-neutral',
  info: 'ui-toast-icon-info',
  loading: 'ui-toast-icon-info',
  success: 'ui-toast-icon-success',
  error: 'ui-toast-icon-error',
};
const POSITION_CLASS = {
  'top-left': 'ui-toast-pos-top-left',
  'top-center': 'ui-toast-pos-top-center',
  'top-right': 'ui-toast-pos-top-right',
  'bottom-left': 'ui-toast-pos-bottom-left',
  'bottom-center': 'ui-toast-pos-bottom-center',
  'bottom-right': 'ui-toast-pos-bottom-right',
};

const cx = (...parts) => parts.filter(Boolean).join(' ');

let idSeed = 0;

function createToast(input, defaultDuration) {
  return {
    duration: defaultDuration,
    dismissible: true,
    ...input,
    id: input.id ?? `toast-${Date.now()}-${idSeed++}`,
    createdAt: Date.now(),
  };
}

export function useAnimatedToastStack({ initialToasts = [], defaultDuration = 4200, limit } = {}) {
  const toastTimers = useRef(new Map());
  const [toasts, setToasts] = useState(() => initialToasts.map((t) => createToast(t, defaultDuration)));

  const dismissToast = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const clearToasts = useCallback(() => setToasts([]), []);

  const showToast = useCallback(
    (input) => {
      const toast = createToast(input, defaultDuration);
      setToasts((current) => {
        const next = [...current, toast];
        return typeof limit === 'number' ? next.slice(-limit) : next;
      });
      return toast.id;
    },
    [defaultDuration, limit],
  );

  const updateToast = useCallback((id, patch) => {
    setToasts((current) =>
      current.map((toast) =>
        toast.id === id
          ? { ...toast, ...patch, id, createdAt: patch.duration === undefined ? toast.createdAt : Date.now() }
          : toast,
      ),
    );
  }, []);

  useEffect(() => {
    const activeIds = new Set(toasts.map((t) => t.id));
    toastTimers.current.forEach((entry, id) => {
      if (!activeIds.has(id)) {
        window.clearTimeout(entry.timer);
        toastTimers.current.delete(id);
      }
    });

    toasts.forEach((toast) => {
      const duration = toast.duration ?? defaultDuration;
      const existing = toastTimers.current.get(toast.id);

      if (duration <= 0) {
        if (existing) {
          window.clearTimeout(existing.timer);
          toastTimers.current.delete(toast.id);
        }
        return;
      }

      const createdAt = toast.createdAt ?? Date.now();
      const signature = `${createdAt}:${duration}`;
      if (existing?.signature === signature) return;
      if (existing) window.clearTimeout(existing.timer);

      const remaining = Math.max(duration - (Date.now() - createdAt), 0);
      const timer = window.setTimeout(() => {
        toastTimers.current.delete(toast.id);
        dismissToast(toast.id);
      }, remaining);
      toastTimers.current.set(toast.id, { timer, signature });
    });
  }, [defaultDuration, dismissToast, toasts]);

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      timers.forEach((entry) => window.clearTimeout(entry.timer));
      timers.clear();
    };
  }, []);

  return useMemo(
    () => ({ toasts, showToast, updateToast, dismissToast, clearToasts, setToasts }),
    [clearToasts, dismissToast, showToast, toasts, updateToast],
  );
}

export function AnimatedToastStack({
  toasts,
  onDismiss,
  position = 'bottom-right',
  placement,
  fixed = false,
  portal,
  portalRoot,
  maxVisible = 4,
  className,
  icons,
  renderToast,
}) {
  const [portalTarget, setPortalTarget] = useState(null);
  const visibleToasts = toasts.slice(-maxVisible);
  const isBottom = position.startsWith('bottom');
  const resolvedPlacement = placement ?? (fixed ? 'fixed' : 'static');
  const shouldPortal = portal ?? resolvedPlacement === 'fixed';

  useEffect(() => {
    setPortalTarget(shouldPortal ? (portalRoot ?? document.body) : null);
  }, [portalRoot, shouldPortal]);

  const stack = (
    <ol
      aria-live="polite"
      aria-atomic="false"
      className={cx(
        'ui-toast-stack-root',
        isBottom ? 'ui-toast-col-reverse' : 'ui-toast-col',
        resolvedPlacement === 'fixed' && 'ui-toast-fixed',
        resolvedPlacement === 'absolute' && 'ui-toast-absolute',
        resolvedPlacement !== 'static' && POSITION_CLASS[position],
        className,
      )}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {visibleToasts.map((toast, index) => (
          <ToastItem key={toast.id} toast={toast} index={index} onDismiss={onDismiss} icons={icons} renderToast={renderToast} />
        ))}
      </AnimatePresence>
    </ol>
  );

  if (shouldPortal && !portalTarget) return null;
  if (shouldPortal && portalTarget) return createPortal(stack, portalTarget);
  return stack;
}

const ToastItem = memo(function ToastItem({ toast, index, onDismiss, icons, renderToast }) {
  const reduce = useReducedMotion();
  const status = toast.status ?? 'neutral';
  const Icon = STATUS_ICON[status];
  const iconNode = icons?.[status] ?? toast.icon ?? <Icon size={14} />;
  const canDismiss = toast.dismissible !== false && Boolean(onDismiss);

  return (
    <motion.li
      layout
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 22, scale: 0.96, filter: 'blur(10px)' }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
      exit={
        reduce
          ? { opacity: 0 }
          : { opacity: 0, x: 32, scale: 0.96, filter: 'blur(8px)', transition: { duration: 0.18, ease: EASE_OUT } }
      }
      transition={STACK_SPRING}
      drag={canDismiss && !reduce ? 'x' : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.18}
      onDragEnd={(_, info) => {
        if (!canDismiss || !onDismiss) return;
        if (Math.abs(info.offset.x) > 72 || Math.abs(info.velocity.x) > 520) onDismiss(toast.id);
      }}
      className="ui-toast-item"
      style={{ zIndex: 20 - index }}
    >
      <div className="ui-toast-surface">
        {renderToast ? (
          renderToast(toast)
        ) : (
          <div className="ui-toast-row">
            <motion.span layout className={cx('ui-toast-icon-wrap', STATUS_CLASS[status])}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={status}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.8, filter: 'blur(6px)' }}
                  animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.9, filter: 'blur(6px)' }}
                  transition={CONTENT_TRANSITION}
                  className="ui-toast-icon-slot"
                >
                  {status === 'loading' ? <span className="ui-toast-spin">{iconNode}</span> : iconNode}
                </motion.span>
              </AnimatePresence>
            </motion.span>

            <div className="ui-toast-content">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                  key={`${toast.id}-${status}-${String(toast.title)}`}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, filter: 'blur(6px)' }}
                  animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, filter: 'blur(0px)' }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: 'blur(6px)' }}
                  transition={CONTENT_TRANSITION}
                >
                  <p className="ui-toast-title">{toast.title}</p>
                  {toast.description ? <p className="ui-toast-description">{toast.description}</p> : null}
                </motion.div>
              </AnimatePresence>

              {toast.action ? (
                <button type="button" onClick={() => toast.action?.onClick(toast)} className="ui-toast-action">
                  {toast.action.label}
                </button>
              ) : null}
            </div>

            {canDismiss ? (
              <button type="button" onClick={() => onDismiss?.(toast.id)} aria-label="Dismiss toast" className="ui-toast-close">
                <X size={14} />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </motion.li>
  );
});
