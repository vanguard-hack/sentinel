/* ═══════════════════════════════════════════════════════════════════════════
   StatTile — the figures above the fold

   Shaped after motion.dev/ui/stats-sections: a large tabular figure that
   counts up once on arrival, with its supporting detail carried inside the
   tile rather than in a caption beside it.

   WHAT THIS DELIBERATELY DOES NOT DO

   The reference pairs every figure with a sparkline. Four of these eight
   numbers — accused on record, victims recorded, arrests, and the FIR count
   itself — have no series behind them in the report bundle, only a total. A
   sparkline drawn from anything but real history is a trend an officer cannot
   check and has no reason to doubt, so tiles without history get none.

   What each tile can honestly carry:
     · a share bar, where the figure IS a percentage of a real denominator
       (open, solved, heinous, chargesheet rate) — the same number, drawn
     · a trend chip, where a real previous-period delta exists (FIRs)
     · otherwise the figure and its label, and no invented ornament
   ═══════════════════════════════════════════════════════════════════════════ */

import React, { useEffect, useRef } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { animate, useMotionValue, useReducedMotion } from 'motion/react';

/**
 * Counts from zero to `value` once, writing straight to the DOM node so the
 * tick does not re-render the tile sixty times a second.
 *
 * `format` is applied to every intermediate frame, which keeps the thousands
 * separators and decimal places stable while it runs — a figure that gains
 * and loses a comma as it counts is worse than no animation at all.
 */
function useCountUp(value, format) {
  const ref = useRef(null);
  const mv = useMotionValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    if (reduced) { node.textContent = format(value); return undefined; }
    const stop = mv.on('change', (v) => { node.textContent = format(v); });
    const controls = animate(mv, value, { duration: 0.9, ease: [0.16, 1, 0.3, 1] });
    return () => { stop(); controls.stop(); };
  }, [value, format, mv, reduced]);

  return ref;
}

export default function StatTile({
  Icon,
  label,
  value,
  format = (v) => Math.round(v).toLocaleString(),
  sub,
  trend,
  share,
}) {
  const ref = useCountUp(value, format);
  return (
    <div className="st-tile">
      <div className="st-head">
        {Icon && <span className="st-icon"><Icon size={15} strokeWidth={1.8} /></span>}
        <span className="st-label">{label}</span>
        {trend && (
          <span className={`st-trend st-trend-${trend.dir}`}>
            {trend.dir === 'up' ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
            {trend.text}
          </span>
        )}
      </div>

      <span className="st-value" ref={ref}>{format(0)}</span>

      {/* Only drawn when the figure is a share of something real. */}
      {share != null && (
        <div className="st-share" aria-hidden="true">
          <span className="st-share-fill" style={{ width: `${Math.max(2, Math.min(100, share))}%` }} />
        </div>
      )}

      {sub && <span className="st-sub">{sub}</span>}
    </div>
  );
}
