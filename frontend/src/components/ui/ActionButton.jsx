import { useRef, useState } from 'react';
import './ActionButton.css';

export default function ActionButton({
  icon: Icon, doneIcon: DoneIcon, label, doneLabel, onAction, revertAfter = 2000, className,
}) {
  const [done, setDone] = useState(false);
  const timerRef = useRef(null);

  const handleClick = async () => {
    try {
      await onAction();
      setDone(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setDone(false), revertAfter);
    } catch {
      // Swallowed intentionally: a failed action stays in its normal state
      // rather than falsely claiming success — the caller is responsible for
      // surfacing the failure (e.g. via useAnimatedToastStack).
    }
  };

  const ShownIcon = done ? DoneIcon : Icon;
  return (
    <button type="button" className={`ui-action-btn ${className || ''}`} onClick={handleClick} title={done ? doneLabel : label} aria-label={done ? doneLabel : label}>
      <ShownIcon size={15} />
    </button>
  );
}
