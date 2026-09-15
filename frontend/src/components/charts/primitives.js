/* ═══════════════════════════════════════════════════════════════════════════
   Shared chart primitives

   Extracted from the vendored Bklit line chart so the rest of the set can
   speak the same visual language rather than each re-implementing it. The
   treatment these encode is Bklit's:

     · marks fade out at the leading and trailing edges
     · the grid is dashed and masked so it dissolves rather than stopping
     · marks draw themselves on once, then never animate again
     · hovering drops the whole set back and lifts only what is under the
       cursor
     · every url(#id) is per-instance

   The last one is not cosmetic. Ids were hardcoded in the first port, so two
   charts on one page silently painted with the first one's gradients.
   ═══════════════════════════════════════════════════════════════════════════ */

import React, { useEffect, useId, useState } from 'react';

export const CATS = 6;
export const DRAW_MS = 900;
export const EASE = 'cubic-bezier(0.85, 0, 0.15, 1)';
export const SPRING = { stiffness: 520, damping: 42, mass: 0.6 };
export const DIM = 0.28;

/** Colour for series/category slot i, from the shared ramp. */
export const cat = (i) => `var(--rp-cat-${i % CATS})`;

/** A DOM-id prefix unique to this component instance. */
export function useChartId() {
  return useId().replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * One-shot reveal.
 *
 * Returns false on the first paint and true immediately after, so a mark can
 * transition from its collapsed state to its real one. Honours
 * prefers-reduced-motion by starting already drawn — the chart is complete
 * either way, it just arrives without the flourish.
 */
export function useDrawOn(ready = true) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (drawn || !ready) return undefined;
    const reduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { setDrawn(true); return undefined; }
    const raf = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(raf);
  }, [drawn, ready]);
  return drawn;
}

export const fmtTick = (v) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000 ? `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`
      : String(Math.round(v));

/**
 * Horizontal fade gradient for a series mark.
 *
 * Bklit strokes its lines through this rather than with a flat colour, which
 * is what stops a line from ending in a hard stub at the plot edge.
 */
export function EdgeFade({ id, color, from = 12, to = 88 }) {
  return (
    <linearGradient id={id} x1="0%" x2="100%" y1="0%" y2="0%">
      <stop offset="0%" stopColor={color} stopOpacity="0" />
      <stop offset={`${from}%`} stopColor={color} stopOpacity="1" />
      <stop offset={`${to}%`} stopColor={color} stopOpacity="1" />
      <stop offset="100%" stopColor={color} stopOpacity="0" />
    </linearGradient>
  );
}

/** Vertical fill fade, for area marks and bars. */
export function FillFade({ id, color, top = 0.34, bottom = 0 }) {
  return (
    <linearGradient id={id} x1="0%" x2="0%" y1="0%" y2="100%">
      <stop offset="0%" stopColor={color} stopOpacity={top} />
      <stop offset="100%" stopColor={color} stopOpacity={bottom} />
    </linearGradient>
  );
}

/**
 * Dashed grid rows, masked to fade out at both ends.
 *
 * Vendored from Bklit's ChartGrid, reduced to the one configuration the app
 * uses and rewritten to take explicit tick values so it does not need a visx
 * scale object — several of these charts compute their own.
 */
export function FadedGrid({ id, ticks, y, width, height }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-f`} x1="0%" x2="100%" y1="0%" y2="0%">
          <stop offset="0%" stopColor="#fff" stopOpacity="0" />
          <stop offset="10%" stopColor="#fff" stopOpacity="1" />
          <stop offset="90%" stopColor="#fff" stopOpacity="1" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}-m`}>
          <rect x="0" y="0" width={width} height={height} fill={`url(#${id}-f)`} />
        </mask>
      </defs>
      <g mask={`url(#${id}-m)`}>
        {ticks.map((t) => (
          <line
            key={t}
            x1={0}
            x2={width}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--chart-grid)"
            strokeDasharray="4,4"
          />
        ))}
      </g>
    </>
  );
}

/**
 * The tooltip.
 *
 * Reuses the .lc-tip classes the hand-rolled charts already had, so a
 * converted chart and an unconverted one sitting side by side still agree
 * about what a tooltip looks like while the conversion is partway done.
 */
export function Tip({ x, width, title, rows }) {
  const flip = x > width / 2;
  return (
    <div
      className="lc-tip"
      style={flip
        ? { left: x - 14, transform: 'translateX(-100%)' }
        : { left: x + 14 }}
    >
      {title && <div className="lc-tip-title">{title}</div>}
      {rows.map((r) => (
        <div className="lc-tip-row" key={r.name}>
          {r.color && <span className="lc-tip-dot" style={{ background: r.color }} />}
          {r.name}
          <b>{r.value}</b>
        </div>
      ))}
    </div>
  );
}
