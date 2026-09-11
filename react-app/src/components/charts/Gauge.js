/* ═══════════════════════════════════════════════════════════════════════════
   Gauge — semicircular arc for a single percentage figure

   Bklit-style KPI gauge (bklit.com/charts/gauge-chart): a half-circle track
   with a value arc that sweeps in on mount. Sits inside a StatTile in place
   of the thin `.st-share` bar — same data, same var(--primary) accent, just
   drawn as an arc instead of a line. Reveal reuses the exact pathLength=1 /
   strokeDasharray=1 / strokeDashoffset technique TrendArea already draws its
   line with, rather than inventing a second animation approach.
   ═══════════════════════════════════════════════════════════════════════════ */

import React from 'react';
import { DRAW_MS, EASE, useDrawOn } from './primitives';

const W = 92;
const H = 50;
const STROKE = 7;
const R = H - STROKE / 2 - 1;
const CX = W / 2;
const CY = H - 1;

const arcPoint = (angle) => [CX + R * Math.cos(angle), CY + R * Math.sin(angle)];

// A semicircle from left (π) to the given end angle, clockwise.
const arcPath = (endAngle) => {
  const [x0, y0] = arcPoint(Math.PI);
  const [x1, y1] = arcPoint(endAngle);
  const largeArc = endAngle - Math.PI > Math.PI ? 1 : 0;
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${largeArc} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
};

export default function Gauge({ value, ariaLabel = 'Gauge' }) {
  const drawn = useDrawOn(true);
  const pct = Math.max(0, Math.min(100, value || 0));
  const frac = pct / 100;

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="st-gauge-svg" role="img" aria-label={`${ariaLabel}: ${pct}%`}>
      <path d={arcPath(2 * Math.PI)} fill="none" stroke="var(--bg-3)" strokeWidth={STROKE} strokeLinecap="round" />
      {frac > 0 && (
        <path
          d={arcPath(Math.PI + frac * Math.PI)}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray="1"
          style={{
            strokeDashoffset: drawn ? 0 : 1,
            transition: `stroke-dashoffset ${DRAW_MS}ms ${EASE}`,
          }}
        />
      )}
    </svg>
  );
}
