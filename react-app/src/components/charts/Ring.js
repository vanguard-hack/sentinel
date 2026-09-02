/* ═══════════════════════════════════════════════════════════════════════════
   Ring — donut / composition chart

   Replaces the Charts.js Donut. Same props and the same centre readout, so it
   is a drop-in.

   The Bklit treatment on a ring is a sweep: every arc starts at zero length
   and unrolls clockwise on first paint, using the same stroke-dashoffset
   technique the line charts draw with. Hovering a slice or its legend row
   drops the rest of the ring back and swaps the centre readout, which is the
   behaviour the hand-rolled version already had and worth keeping.
   ═══════════════════════════════════════════════════════════════════════════ */

import React, { useState } from 'react';
import { DIM, DRAW_MS, EASE, cat, useDrawOn } from './primitives';
import './chart-tokens.css';

const SIZE = 136;
const STROKE = 15;

export default function Ring({ data, ariaLabel = 'Composition' }) {
  const [active, setActive] = useState(null);
  const drawn = useDrawOn(true);
  if (!data || !data.length) return <div className="rp-empty">No data</div>;

  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const c = SIZE / 2;
  const r = (SIZE - STROKE) / 2;
  const circ = 2 * Math.PI * r;

  /* Butt caps plus float rounding leave a hairline crack where two arcs meet,
     which reads as a fifth, tiny category. Each arc is drawn a shade long and
     the next one paints over the overlap. */
  const overlap = data.length > 1 ? 1.5 : 0;
  let offset = 0;
  const segs = data.map((d, i) => {
    const len = (d.value / total) * circ;
    const seg = { i, len, dash: Math.min(circ, Math.max(0.001, len + overlap)), offset };
    offset += len;
    return seg;
  });

  const shown = active != null ? data[active] : null;

  return (
    <div className="rp-donut-wrap">
      <div className="rp-donut-svg" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={ariaLabel}>
          <g transform={`rotate(-90 ${c} ${c})`}>
            {segs.map((s) => (
              <circle
                key={s.i}
                cx={c}
                cy={c}
                r={r}
                fill="none"
                stroke={cat(s.i)}
                strokeWidth={STROKE}
                /* Each arc is its own dash: one filled run of `len`, then a
                   gap covering the rest of the circle, rotated into place by
                   the running offset. Unrolling it is just moving the dash
                   offset from the arc's full length back to zero. */
                strokeDasharray={`${s.dash} ${circ - s.dash}`}
                strokeDashoffset={drawn ? -s.offset : s.dash - s.offset}
                opacity={active != null && active !== s.i ? DIM : 1}
                style={{
                  transition: `stroke-dashoffset ${DRAW_MS}ms ${EASE}, opacity 0.25s ease`,
                  cursor: 'pointer',
                }}
                onMouseEnter={() => setActive(s.i)}
                onMouseLeave={() => setActive(null)}
              />
            ))}
          </g>
        </svg>
        <div className="rp-donut-hole">
          {!shown && <span className="rp-donut-cap">Total</span>}
          <span className="rp-donut-total">
            {(shown ? shown.value : total).toLocaleString()}
          </span>
          {shown && (
            <span className="rp-donut-pct">
              {Math.round((shown.value / total) * 100)}%
            </span>
          )}
        </div>
      </div>
      <ul className="rp-legend">
        {data.map((d, i) => (
          <li
            key={`${d.label}-${i}`}
            className={active === i ? 'active' : ''}
            style={{ opacity: active != null && active !== i ? 0.45 : 1 }}
            title={`${d.label}: ${d.value.toLocaleString()} (${Math.round((d.value / total) * 100)}%)`}
            tabIndex={0}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          >
            <span className="rp-legend-dot" style={{ background: cat(i) }} />
            <span className="rp-legend-label">{d.label}</span>
            <span className="rp-legend-val">{Math.round((d.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
