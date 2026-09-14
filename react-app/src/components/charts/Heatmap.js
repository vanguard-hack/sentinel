/* ═══════════════════════════════════════════════════════════════════════════
   CalendarHeatmap — daily contribution grid

   Visual treatment follows Bklit UI's heatmap chart (MIT, bklit/bklit-ui):
   square cells, Monday-first rows, compact Mon/Wed/Fri labels, calendar
   quarter separators with a vertical fade, hover dimming, and a Less→More
   swatch legend. Counts are real FIR totals, not GitHub-style 0–4 buckets
   stored as the value — the five fill levels are derived from the max.
   ═══════════════════════════════════════════════════════════════════════════ */

import React, { useMemo, useState } from 'react';
import useMeasuredBox from '../useMeasuredBox';
import { DRAW_MS, EASE, useChartId, useDrawOn } from './primitives';
import './chart-tokens.css';

const DAY = 86400000;
const WEEK_START = 1; // Monday
const ROWS = 7;
const PAD_L = 32;
const PAD_T = 18;
const PAD_R = 8;
const PAD_B = 4;
const GAP = 4;
const BIN_MIN = 12;
const BIN_MAX = 24;
const CORNER = 2;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LEVELS = 5;
const SCALE = Array.from({ length: LEVELS }, (_, i) => `var(--chart-scale-0${i + 1})`);

export function utcDay(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function rowOf(ts, weekStart = WEEK_START) {
  return (new Date(ts).getUTCDay() + 7 - weekStart) % 7;
}

/** Pack a consecutive daily series into week columns (Monday-first). */
export function columnsFromDays(days) {
  if (!days?.length) return [];
  const first = days[0].ts;
  const last = days[days.length - 1].ts;
  const byTs = new Map(days.map((d) => [d.ts, d.value]));
  const startTs = first - rowOf(first) * DAY;
  const cols = [];
  for (let t = startTs; t <= last; t += 7 * DAY) {
    const bins = [];
    for (let r = 0; r < ROWS; r++) {
      const ts = t + r * DAY;
      const inRange = ts >= first && ts <= last;
      bins.push({ bin: r, count: inRange ? (byTs.get(ts) || 0) : null, date: ts });
    }
    cols.push({ bin: cols.length, bins });
  }
  return cols;
}

function levelOf(count, max) {
  if (count == null || count <= 0 || max <= 0) return 0;
  const t = count / max;
  if (t <= 0.25) return 1;
  if (t <= 0.5) return 2;
  if (t <= 0.75) return 3;
  return 4;
}

function fmtDay(ts) {
  const d = new Date(ts);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export default function CalendarHeatmap({ days, ariaLabel = 'Daily crime registrations' }) {
  const [wrapRef, box] = useMeasuredBox(960, 280);
  const uid = useChartId();
  const drawn = useDrawOn(true);
  const [hover, setHover] = useState(null); // { c, r }

  const cols = useMemo(() => columnsFromDays(days), [days]);
  const max = useMemo(
    () => Math.max(1, ...cols.flatMap((c) => c.bins.map((b) => b.count || 0))),
    [cols]
  );

  const n = Math.max(1, cols.length);
  const innerW = Math.max(1, box.w - PAD_L - PAD_R);
  const innerH = Math.max(1, box.h - PAD_T - PAD_B - 22);
  const heightFit = Math.floor((innerH - (ROWS - 1) * GAP) / ROWS);
  const widthFit = Math.floor((innerW - (n - 1) * GAP) / n);
  const bin = Math.max(BIN_MIN, Math.min(BIN_MAX, heightFit, widthFit > 0 ? widthFit : BIN_MIN));
  const gridW = n * bin + (n - 1) * GAP;
  const gridH = ROWS * bin + (ROWS - 1) * GAP;
  const svgW = Math.max(box.w, PAD_L + gridW + PAD_R);
  const x0 = PAD_L;
  const y0 = PAD_T;

  const monthTicks = [];
  let prevMonth = -1;
  cols.forEach((c, i) => {
    const d = new Date(c.bins.find((b) => b.count != null)?.date ?? c.bins[0].date);
    const m = d.getUTCMonth();
    if (m !== prevMonth) {
      monthTicks.push({ i, label: MON[m] });
      prevMonth = m;
    }
  });

  const quarters = [];
  monthTicks.forEach((t) => {
    const month = MON.indexOf(t.label);
    if (month % 3 === 0) quarters.push(t.i);
  });

  const tip = hover && cols[hover.c]?.bins[hover.r];
  const cx = (i) => x0 + i * (bin + GAP);
  const cy = (row) => y0 + row * (bin + GAP);

  if (!cols.length) return <div className="rp-empty">No data</div>;

  return (
    <div className="bk-heat" ref={wrapRef}>
      <svg
        className="bk-chart-svg"
        width={svgW}
        height={PAD_T + gridH + PAD_B}
        role="img"
        aria-label={ariaLabel}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`bk-heat-fade-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--border)" stopOpacity="0" />
            <stop offset="45%" stopColor="var(--border)" stopOpacity="1" />
            <stop offset="100%" stopColor="var(--border)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {monthTicks.map((t) => (
          <text
            key={`m${t.i}`}
            className="bk-chart-tick"
            x={cx(t.i)}
            y={11}
            textAnchor="start"
          >
            {t.label}
          </text>
        ))}

        {DOW.map((label, row) => (
          row % 2 ? null : (
            <text
              key={label}
              className="bk-chart-tick"
              x={PAD_L - 6}
              y={cy(row) + bin / 2 + 3}
              textAnchor="end"
              opacity={row >= 5 ? 0.4 : 1}
            >
              {label}
            </text>
          )
        ))}

        {quarters.map((i) => (
          <line
            key={`q${i}`}
            x1={cx(i) - GAP / 2}
            x2={cx(i) - GAP / 2}
            y1={y0}
            y2={y0 + gridH}
            stroke={`url(#bk-heat-fade-${uid})`}
            strokeWidth={1}
          />
        ))}

        {cols.map((col, ci) => col.bins.map((b, ri) => {
          if (b.count == null) return null;
          const lvl = levelOf(b.count, max);
          const on = hover && hover.c === ci && hover.r === ri;
          const dim = hover && !on;
          const weekend = ri >= 5;
          return (
            <rect
              key={`${ci}-${ri}`}
              x={cx(ci)}
              y={cy(ri)}
              width={bin}
              height={bin}
              rx={CORNER}
              fill={SCALE[lvl]}
              opacity={drawn ? (dim ? 0.3 : weekend ? 0.72 : 1) : 0}
              style={{
                transition: `opacity ${DRAW_MS}ms ${EASE}`,
                transitionDelay: drawn ? '0ms' : `${Math.min(400, ci * 8)}ms`,
                cursor: 'pointer',
              }}
              onMouseEnter={() => setHover({ c: ci, r: ri })}
            >
              <title>{`${fmtDay(b.date)}: ${b.count.toLocaleString()} FIRs`}</title>
            </rect>
          );
        }))}
      </svg>

      {tip && tip.count != null && (
        <div
          className="lc-tip"
          style={
            cx(hover.c) < box.w / 2
              ? { left: cx(hover.c) + bin + 8 }
              : { left: cx(hover.c) - 8, transform: 'translateX(-100%)' }
          }
        >
          <div className="lc-tip-title">{fmtDay(tip.date)}</div>
          <div className="lc-tip-row">
            Registrations
            <b>{tip.count.toLocaleString()}</b>
          </div>
        </div>
      )}

      <div className="bk-heat-legend" aria-hidden="true">
        <span>Less</span>
        {SCALE.map((fill, i) => (
          <span key={i} className="bk-heat-swatch" style={{ background: fill }} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
