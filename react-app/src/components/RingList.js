import React, { useCallback, useRef, useState } from 'react';

// Virtualised ring list. The explorer previously rendered only the first 40
// rings; with hundreds of them every ring should be reachable, but mounting a
// row per ring wastes DOM for a list where a dozen are visible. Only the
// visible window (plus a small overscan) is mounted.
const ROW = 58;      // keep in step with .cl-ring height + gap in index.css
const OVERSCAN = 6;

export default function RingList({ networks, selectedId, onSelect }) {
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(560);
  const ref = useRef(null);

  const onScroll = useCallback((e) => setScrollTop(e.currentTarget.scrollTop), []);
  const measure = useCallback((el) => {
    ref.current = el;
    if (el) setHeight(el.clientHeight || 560);
  }, []);

  const total = networks.length;
  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW) + OVERSCAN);
  const slice = networks.slice(first, last);

  return (
    <div className="cl-ring-scroll" ref={measure} onScroll={onScroll}>
      <div style={{ height: total * ROW, position: 'relative' }}>
        {slice.map((n, i) => {
          const idx = first + i;
          return (
            <button
              key={n.id}
              className={`cl-ring ${n.id === selectedId ? 'active' : ''}`}
              style={{ position: 'absolute', top: idx * ROW, left: 0, right: 0 }}
              onClick={() => onSelect(n.id)}
              aria-current={n.id === selectedId ? 'true' : undefined}
            >
              <span className="cl-ring-rank">#{n.rank}</span>
              <span className="cl-ring-main">
                <span className="cl-ring-name">{String(n.leader?.name || '—').split(' ')[0]}’s ring</span>
                <span className="cl-ring-sub">{n.size} members · {n.district}</span>
              </span>
              <span className="cl-ring-type">{n.topType}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
