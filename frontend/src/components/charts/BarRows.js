/* ═══════════════════════════════════════════════════════════════════════════
   BarRows — horizontal bars with a label column

   Replaces the Charts.js HBarList. Same props, so it is a drop-in.

   Deliberately still HTML rather than SVG. This chart is mostly a list of
   category names, and the browser is better at eliding "Sampangiramnagar" in
   a fixed column than any <text> layout we would write. The Bklit treatment
   is applied in CSS instead of in SVG: a horizontal fill fade, bars that grow
   from zero on first paint, and a hover that drops the other rows back.
   ═══════════════════════════════════════════════════════════════════════════ */

import React, { useState } from 'react';
import { useDrawOn, cat } from './primitives';
import './chart-tokens.css';

export default function BarRows({
  data,
  format = (v) => v.toLocaleString(),
  suffix = '',
  percent = true,
  colorBy = 'series',
}) {
  const [active, setActive] = useState(null);
  const drawn = useDrawOn(true);
  if (!data || !data.length) return <div className="rp-empty">No data</div>;

  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((s, d) => s + d.value, 0) || 1;

  return (
    <div className="rp-bars bk-bars" onMouseLeave={() => setActive(null)}>
      {data.map((d, i) => {
        const pct = Math.round((d.value / total) * 100);
        const w = Math.min(100, Math.max(2, (d.value / max) * 100));
        const color = colorBy === 'category' ? cat(i) : 'var(--rp-series)';
        return (
          <div
            className={`rp-bar-row${active != null && active !== i ? ' bk-dim' : ''}`}
            key={`${d.label}-${i}`}
            tabIndex={0}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            title={`${d.label}: ${format(d.value)}${suffix}${percent ? ` · ${pct}% of total` : ''}`}
          >
            <div className="rp-bar-label" title={d.label}>{d.label}</div>
            <div className="rp-bar-track">
              <div
                className="rp-bar-fill"
                style={{
                  width: drawn ? `${w}%` : '0%',
                  /* Graded along its length, but it must not fade out at the
                     end: on a bar the end IS the value, so a soft edge makes
                     the number harder to read rather than softer. Lines can
                     fade at the plot edge because their endpoint carries no
                     meaning; bars cannot. */
                  background: `linear-gradient(90deg, color-mix(in srgb, ${color} 76%, transparent) 0%, ${color} 100%)`,
                }}
              />
            </div>
            <div className="rp-bar-val">
              <span className="rp-bar-count">{format(d.value)}{suffix}</span>
              {percent && <span className="rp-bar-pct">{pct}%</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
