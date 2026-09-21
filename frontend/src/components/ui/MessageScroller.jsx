import React, { useEffect, useRef } from 'react';
import './MessageScroller.css';

export default function MessageScroller({ children, dependency, followThreshold = 56, className }) {
  const ref = useRef(null);
  const followRef = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    followRef.current = distanceFromBottom <= followThreshold;
  };

  useEffect(() => {
    const el = ref.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [dependency]);

  return (
    <div ref={ref} className={`ui-message-scroller ${className || ''}`} onScroll={onScroll}>
      {children}
    </div>
  );
}
