/* ═══════════════════════════════════════════════════════════════════════════
   Pie — part-to-whole, no centre hole

   Sibling to Ring.js (the donut): same categorical ramp, same legend markup,
   same hover behaviour (dim the rest), but drawn as filled wedges rather than
   a stroked ring, matching bklit.com/charts/pie-chart's basic pie. Hovering a
   slice nudges it outward slightly along its own bisector — Bklit's "grow"
   hover — instead of thickening a stroke, since a filled wedge has no stroke
   to thicken.
   ═══════════════════════════════════════════════════════════════════════════ */

import React, { useState } from 'react';
import { DIM, DRAW_MS, EASE, cat } from './primitives';
import './chart-tokens.css';

const SIZE = 136;
const R = SIZE / 2;
const NUDGE = 6;

export default function Pie({ data, ariaLabel = 'Composition' }) {
  const [active, setActive] = useState(null);
  if (!data || !data.length) return <div className="rp-empty">No data</div>;

  const total = data.reduce((s, d) => s + d.value, 0) || 1;

  let acc = -Math.PI / 2; // 12 o'clock, same start as Ring
  const segs = data.map((d, i) => {
    const a0 = acc;
    const a1 = acc + (d.value / total) * 2 * Math.PI;
    acc = a1;
    const mid = (a0 + a1) / 2;
    return { i, a0, a1, mid };
  });

  const pt = (a) => [R + R * Math.cos(a), R + R * Math.sin(a)];
  const wedgePath = (a0, a1) => {
    const [x0, y0] = pt(a0);
    const [x1, y1] = pt(a1);
    const largeArc = a1 - a0 > Math.PI ? 1 : 0;
    return `M${R},${R} L${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${largeArc} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`;
  };

  const shown = active != null ? data[active] : null;

  return (
    <div className="rp-donut-wrap">
      <div className="rp-donut-svg" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={ariaLabel}>
          {segs.length === 1 ? (
            <circle cx={R} cy={R} r={R} fill={cat(0)} />
          ) : (
            segs.map((s) => {
              const isActive = active === s.i;
              const nudge = isActive ? NUDGE : 0;
              return (
                <path
                  key={s.i}
                  d={wedgePath(s.a0, s.a1)}
                  fill={cat(s.i)}
                  opacity={active != null && !isActive ? DIM : 1}
                  style={{
                    transform: `translate(${(Math.cos(s.mid) * nudge).toFixed(2)}px, ${(Math.sin(s.mid) * nudge).toFixed(2)}px)`,
                    transition: `transform ${DRAW_MS / 3}ms ${EASE}, opacity 0.25s ease`,
                    cursor: 'pointer',
                  }}
                  onMouseEnter={() => setActive(s.i)}
                  onMouseLeave={() => setActive(null)}
                />
              );
            })
          )}
        </svg>
      </div>
      <ul className="rp-legend">
        {data.map((d, i) => {
          const pct = Math.round((d.value / total) * 100);
          return (
            <li
              key={`${d.label}-${i}`}
              className={active === i ? 'active' : ''}
              style={{ opacity: active != null && active !== i ? 0.45 : 1 }}
              title={`${d.label}: ${d.value.toLocaleString()} (${pct}%)`}
              tabIndex={0}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            >
              <span className="rp-legend-dot" style={{ background: cat(i) }} />
              <span className="rp-legend-label">{d.label}</span>
              <span className="rp-legend-val">
                {shown === d ? d.value.toLocaleString() : `${pct}%`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
