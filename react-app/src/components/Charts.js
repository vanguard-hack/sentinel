import React, { useState, useMemo } from 'react';

// Area trend — one series over ordered periods, with reference-grade chrome:
// dashed gridlines with y-ticks, a vertical hover cursor with a ring marker,
// a floating tooltip card, and a soft gradient fill under the line. Points
// flagged `forecast: true` (a suffix of the series) render dashed.
const niceCeil = (raw) => {
  const r = Math.max(1, raw);
  const pow = 10 ** Math.floor(Math.log10(r));
  return [1, 1.5, 2, 2.5, 5, 10].map((m) => m * pow).find((m) => m >= r) || r;
};
const fmtTick = (v) => (v >= 1000 ? `${Math.round((v / 1000) * 10) / 10}k` : Math.round(v * 10) / 10);

// Catmull-Rom → cubic bezier: the smooth curves the BRIX chart kit uses.
// Control-point y is clamped so counts never dip below the baseline.
const smoothPath = (pts, yMin, yMax) => {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  const cl = (v) => Math.max(yMin, Math.min(yMax, v));
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    d += ` C${(p1.x + (p2.x - p0.x) / 6).toFixed(2)},${cl(p1.y + (p2.y - p0.y) / 6).toFixed(2)}`
      + ` ${(p2.x - (p3.x - p1.x) / 6).toFixed(2)},${cl(p2.y - (p3.y - p1.y) / 6).toFixed(2)}`
      + ` ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
};

// Measure the wrapper so the viewBox matches real pixels — text renders at
// its natural size instead of being stretched by preserveAspectRatio="none".
function useMeasuredWidth(initial = 600) {
  const ref = React.useRef(null);
  const [w, setW] = useState(initial);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect?.width;
      if (cw) setW(Math.max(320, Math.round(cw)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

let areaSeq = 0;
export function TrendArea({ data, height = 230, labelEvery = 1 }) {
  const [active, setActive] = useState(null);
  const [wrapRef, mw] = useMeasuredWidth();
  const gradId = useMemo(() => `areagrad-${++areaSeq}`, []);
  if (!data || !data.length) return <div className="rp-empty">No data</div>;

  const n = data.length;
  const w = mw;
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 30;
  const innerW = w - padL - padR;
  const innerH = height - padT - padB;
  const maxV = niceCeil(Math.max(1, ...data.map((d) => d.value)));
  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padT + innerH * (1 - v / maxV);
  const base = padT + innerH;

  const fcStart = data.findIndex((d) => d.forecast);
  const solid = fcStart === -1 ? data : data.slice(0, fcStart);
  const dashed = fcStart === -1 ? [] : data.slice(Math.max(0, fcStart - 1));
  const xy = (arr, off) => arr.map((d, i) => ({ x: x(i + off), y: y(d.value) }));
  const solidPath = smoothPath(xy(solid, 0), padT, base);
  const dashedPath = smoothPath(xy(dashed, Math.max(0, fcStart - 1)), padT, base);
  const areaPath = solid.length > 1
    ? `${solidPath} L${x(solid.length - 1)},${base} L${x(0)},${base} Z`
    : '';

  const every = Math.max(labelEvery, Math.ceil(n / Math.max(2, Math.floor(innerW / 80))));
  const shown = active != null ? data[active] : null;
  // Beside the cursor, never on top of it: right of it on the left half,
  // left of it on the right half.
  const tipStyle = active == null ? null
    : x(active) < w / 2
      ? { left: x(active) + 14 }
      : { left: x(active) - 14, transform: 'translateX(-100%)' };

  return (
    <div className="trend-wrap lc-wrap" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        className="trend-svg"
        role="img"
        onMouseLeave={() => setActive(null)}
      >
        <defs>
          {/* BRIX "Line Gradient": #765DFF → #CFCAFF → #FFF, multiply @ 0.33 */}
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#765DFF" />
            <stop offset="48.25%" stopColor="#CFCAFF" />
            <stop offset="100%" stopColor="#FFFFFF" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={w - padR} y1={y(maxV * f)} y2={y(maxV * f)} className="col-grid" />
            <text x={padL - 6} y={y(maxV * f) + 3} textAnchor="end" className="col-tick">{fmtTick(maxV * f)}</text>
          </g>
        ))}
        <line x1={padL} x2={w - padR} y1={base} y2={base} className="col-grid col-grid-base" />
        {areaPath && <path d={areaPath} fill={`url(#${gradId})`} className="lc-area" />}
        {solid.length > 1 && <path d={solidPath} className="lc-line" fill="none" style={{ stroke: '#765DFF' }} />}
        {dashed.length > 1 && <path d={dashedPath} className="lc-line lc-line-dashed" fill="none" style={{ stroke: '#765DFF' }} />}
        {active != null && (
          <>
            <line x1={x(active)} x2={x(active)} y1={padT} y2={base} className="lc-cursor" />
            <circle cx={x(active)} cy={y(data[active].value)} r="4.5" className="lc-ring" style={{ stroke: '#765DFF' }} />
          </>
        )}
        {data.map((d, i) =>
          i % every === 0 ? (
            <text key={`l${i}`} x={x(i)} y={height - 6} textAnchor="middle" className="col-label">
              {d.label}
            </text>
          ) : null
        )}
        {data.map((d, i) => (
          <rect
            key={`h${i}`}
            x={x(i) - innerW / n / 2}
            y={0}
            width={innerW / n}
            height={height}
            fill="transparent"
            onMouseEnter={() => setActive(i)}
          />
        ))}
      </svg>
      {shown && (
        <div className="lc-tip" style={tipStyle}>
          <div className="lc-tip-title">{shown.label}{shown.forecast ? ' · projected' : ''}</div>
          <div className="lc-tip-row">
            <span className="lc-tip-dot" style={{ background: '#765DFF' }} />
            <span className="lc-tip-name">Cases</span>
            <b>{shown.value.toLocaleString()}</b>
          </div>
        </div>
      )}
    </div>
  );
}

// Column chart — vertical bars with rounded tops and a gradient fill, dashed
// y-gridlines with tick values, and a hover readout (label · value · share).
// Long category labels angle at -30° and truncate; the full label lives in the
// readout and tooltip. Keeps the row order it is given (callers pre-sort).
let colSeq = 0;
export function BarList({
  data, format = (v) => v.toLocaleString(), suffix = '', percent = true, height = 215,
  straightLabels = false, caption = true,
}) {
  const [active, setActive] = useState(null);
  const gradId = useMemo(() => `colgrad-${++colSeq}`, []);
  if (!data.length) return <div className="rp-empty">No data</div>;

  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const rawMax = Math.max(1, ...data.map((d) => d.value));
  // Nice axis ceiling: 1/2/2.5/5 × 10^k just above the max.
  const pow = 10 ** Math.floor(Math.log10(rawMax));
  const niceMax = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((m) => m >= rawMax) || rawMax;

  const n = data.length;
  const w = 600;
  const padL = 36;
  const padR = 8;
  const padT = 8;
  const longest = Math.max(...data.map((d) => d.label.length));
  const angled = !straightLabels && (longest > 7 || n > 8);
  const padB = angled ? 52 : 26;
  const innerW = w - padL - padR;
  const innerH = height - padT - padB;
  const slot = innerW / n;
  const barW = Math.min(56, slot * 0.6);
  const yOf = (v) => padT + innerH * (1 - v / niceMax);
  const base = padT + innerH;

  const trunc = (s, m) => (s.length > m ? s.slice(0, m - 1) + '…' : s);
  const shown = active != null ? data[active] : null;

  return (
    <div className="trend-wrap">
      {caption && (
        <div className="trend-readout">
          <span className="trend-readout-cap">
            {shown
              ? `${shown.label} · ${format(shown.value)}${suffix}${percent ? ` · ${Math.round((shown.value / total) * 100)}%` : ''}`
              : `${n} categories${percent ? ` · ${format(total)}${suffix} total` : ''}`}
          </span>
        </div>
      )}
      <svg viewBox={`0 0 ${w} ${height}`} className="col-svg" role="img" onMouseLeave={() => setActive(null)}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--rp-cat-0)" />
            <stop offset="100%" stopColor="var(--rp-cat-0)" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={w - padR} y1={yOf(niceMax * f)} y2={yOf(niceMax * f)} className="col-grid" />
            <text x={padL - 6} y={yOf(niceMax * f) + 3} textAnchor="end" className="col-tick">
              {niceMax * f >= 1000 ? `${(niceMax * f) / 1000}k` : Math.round(niceMax * f * 10) / 10}
            </text>
          </g>
        ))}
        <line x1={padL} x2={w - padR} y1={base} y2={base} className="col-grid col-grid-base" />
        {data.map((d, i) => {
          const x0 = padL + i * slot + (slot - barW) / 2;
          const yTop = yOf(d.value);
          const h = Math.max(0, base - yTop);
          const r = Math.min(7, barW / 2, h);
          const path = h === 0
            ? ''
            : `M${x0},${base} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + barW - r} Q${x0 + barW},${yTop} ${x0 + barW},${yTop + r} V${base} Z`;
          const cx = x0 + barW / 2;
          return (
            <g key={d.label}>
              {path && (
                <path
                  d={path}
                  fill={`url(#${gradId})`}
                  className={`col-bar ${active != null && active !== i ? 'dim' : ''}`}
                />
              )}
              {n <= 8 && h > 0 && (
                <text x={cx} y={yTop - 5} textAnchor="middle" className="col-val">
                  {format(d.value)}
                </text>
              )}
              {angled ? (
                <text
                  x={cx}
                  y={base + 12}
                  textAnchor="end"
                  transform={`rotate(-30 ${cx} ${base + 12})`}
                  className="col-label"
                >
                  {trunc(d.label, 14)}
                </text>
              ) : (
                <text x={cx} y={base + 16} textAnchor="middle" className="col-label">
                  {trunc(d.label, straightLabels ? 16 : 10)}
                </text>
              )}
              <rect
                x={padL + i * slot}
                y={0}
                width={slot}
                height={height}
                fill="transparent"
                onMouseEnter={() => setActive(i)}
              >
                <title>{`${d.label}: ${format(d.value)}${suffix}${percent ? ` · ${Math.round((d.value / total) * 100)}% of total` : ''}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Donut — part-to-whole for a small number of categories, drawn as SVG so each
// slice is its own hit target. Hovering (or focusing) a slice OR its legend row
// lifts that slice, dims the rest, and the centre reads out that slice's value
// (value leads) and share. Colours are the validated categorical slots in fixed
// order; the legend labels + % carry identity so it never relies on colour alone.
export function Donut({ data }) {
  const [active, setActive] = useState(null);
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  if (!data.length) return <div className="rp-empty">No data</div>;

  const size = 136;
  const stroke = 15;
  const c = size / 2;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  // Slight overlap between segments: butt-cap edges and float rounding leave
  // hairline cracks at boundaries otherwise; later segments paint over it.
  const overlap = data.length > 1 ? 1.5 : 0;

  let offset = 0;
  const segs = data.map((d, i) => {
    const len = (d.value / total) * circ;
    const seg = { i, len, offset };
    offset += len;
    return seg;
  });

  // Centre: "Total" over the count at rest; hovering a slice or legend row
  // swaps in that slice's label, count and share.
  const shown = active != null ? data[active] : null;

  return (
    <div className="rp-donut-wrap">
      <div className="rp-donut-svg" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
          <g transform={`rotate(-90 ${c} ${c})`}>
            {segs.map((s) => {
              const isActive = active === s.i;
              const dim = active != null && !isActive;
              const dash = Math.min(circ, Math.max(0.001, s.len + overlap));
              return (
                <circle
                  key={s.i}
                  cx={c}
                  cy={c}
                  r={r}
                  fill="none"
                  stroke={`var(--rp-cat-${s.i})`}
                  strokeWidth={isActive ? stroke + 4 : stroke}
                  strokeDasharray={`${dash} ${circ - dash}`}
                  strokeDashoffset={-s.offset}
                  style={{
                    opacity: dim ? 0.28 : 1,
                    transition: 'opacity .15s, stroke-width .15s',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={() => setActive(s.i)}
                  onMouseLeave={() => setActive(null)}
                />
              );
            })}
          </g>
        </svg>
        <div className="rp-donut-hole">
          {!shown && <span className="rp-donut-cap">Total</span>}
          <span className="rp-donut-total">{(shown ? shown.value : total).toLocaleString()}</span>
          {shown && <span className="rp-donut-pct">{Math.round((shown.value / total) * 100)}%</span>}
        </div>
      </div>
      <ul className="rp-legend">
        {data.map((d, i) => {
          const pct = Math.round((d.value / total) * 100);
          const dim = active != null && active !== i;
          return (
            <li
              key={d.label}
              className={active === i ? 'active' : ''}
              style={{ opacity: dim ? 0.45 : 1 }}
              tabIndex={0}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              title={`${d.label}: ${d.value.toLocaleString()} (${pct}%)`}
            >
              <span className="rp-legend-dot" style={{ background: `var(--rp-cat-${i})` }} />
              <span className="rp-legend-label">{d.label}</span>
              <span className="rp-legend-val">{pct}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Multi-line trend — several series over the same ordered periods, with the
// same chrome as TrendArea: gridlines + ticks, hover cursor with ring markers
// on every series, a floating tooltip card listing each series (and total),
// and a centred legend. Null values are gaps (partial years).
export function MultiLine({ series, height = 250, labelEvery = 1 }) {
  const [active, setActive] = useState(null);
  const [wrapRef, mw] = useMeasuredWidth();
  const rows = (series || []).filter((s) => s.points && s.points.length);
  if (!rows.length) return <div className="rp-empty">No data</div>;

  const n = rows[0].points.length;
  const w = mw;
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 30;
  const innerW = w - padL - padR;
  const innerH = height - padT - padB;
  const maxV = niceCeil(Math.max(1, ...rows.flatMap((s) => s.points.map((p) => p.value ?? 0))));
  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padT + innerH * (1 - v / maxV);
  const base = padT + innerH;

  const every = Math.max(labelEvery, Math.ceil(n / Math.max(2, Math.floor(innerW / 80))));
  const activeRows = active != null
    ? rows.filter((s) => s.points[active].value != null)
    : [];
  const activeTotal = activeRows.reduce((s, r) => s + r.points[active].value, 0);
  const tipStyle = active == null ? null
    : x(active) < w / 2
      ? { left: x(active) + 14 }
      : { left: x(active) - 14, transform: 'translateX(-100%)' };

  return (
    <div className="trend-wrap lc-wrap" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        className="trend-svg"
        role="img"
        onMouseLeave={() => setActive(null)}
      >
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={w - padR} y1={y(maxV * f)} y2={y(maxV * f)} className="col-grid" />
            <text x={padL - 6} y={y(maxV * f) + 3} textAnchor="end" className="col-tick">{fmtTick(maxV * f)}</text>
          </g>
        ))}
        <line x1={padL} x2={w - padR} y1={base} y2={base} className="col-grid col-grid-base" />
        {rows.map((s, si) => {
          const segs = [];
          let cur = [];
          s.points.forEach((p, i) => {
            if (p.value == null) {
              if (cur.length) segs.push(cur);
              cur = [];
            } else {
              cur.push({ x: x(i), y: y(p.value) });
            }
          });
          if (cur.length) segs.push(cur);
          return segs.map((seg, k) => (
            <path
              key={`${s.name}-${k}`}
              fill="none"
              d={smoothPath(seg, padT, base)}
              className="lc-line"
              style={{ stroke: `var(--rp-cat-${si % 6})` }}
            />
          ));
        })}
        {active != null && (
          <line x1={x(active)} x2={x(active)} y1={padT} y2={base} className="lc-cursor" />
        )}
        {active != null &&
          rows.map((s, si) =>
            s.points[active].value == null ? null : (
              <circle
                key={`r${si}`}
                cx={x(active)}
                cy={y(s.points[active].value)}
                r="4.5"
                className="lc-ring"
                style={{ stroke: `var(--rp-cat-${si % 6})` }}
              />
            )
          )}
        {rows[0].points.map((p, i) =>
          i % every === 0 ? (
            <text key={`l${i}`} x={x(i)} y={height - 6} textAnchor="middle" className="col-label">
              {p.label}
            </text>
          ) : null
        )}
        {rows[0].points.map((p, i) => (
          <rect
            key={`h${i}`}
            x={x(i) - innerW / n / 2}
            y={0}
            width={innerW / n}
            height={height}
            fill="transparent"
            onMouseEnter={() => setActive(i)}
          />
        ))}
      </svg>
      {active != null && activeRows.length > 0 && (
        <div className="lc-tip" style={tipStyle}>
          <div className="lc-tip-title">{rows[0].points[active].label}</div>
          {rows.map((s, si) =>
            s.points[active].value == null ? null : (
              <div className="lc-tip-row" key={s.name}>
                <span className="lc-tip-dot" style={{ background: `var(--rp-cat-${si % 6})` }} />
                <span className="lc-tip-name">{s.name}</span>
                <b>{s.points[active].value.toLocaleString()}</b>
              </div>
            )
          )}
          {activeRows.length > 1 && (
            <div className="lc-tip-row lc-tip-total">
              <span className="lc-tip-name">Total</span>
              <b>{activeTotal.toLocaleString()}</b>
            </div>
          )}
        </div>
      )}
      <ul className="rp-legend rp-legend-row lc-legend">
        {rows.map((s, si) => (
          <li key={s.name}>
            <span className="rp-legend-dot" style={{ background: `var(--rp-cat-${si % 6})` }} />
            <span className="rp-legend-label">{s.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Heat grid — rows × cols intensity matrix (e.g. crime head × month).
// Hovering a cell shows its count inside the cell.
export function HeatGrid({ rows, cols, values }) {
  const [hover, setHover] = useState(null); // { r, c }
  if (!rows?.length) return <div className="rp-empty">No data</div>;
  const max = Math.max(1, ...values.flat());
  return (
    <div>
      <div className="rp-heat" onMouseLeave={() => setHover(null)}>
        <div className="rp-heat-row rp-heat-head">
          <span className="rp-heat-label" />
          {cols.map((c) => <span key={c} className="rp-heat-col">{c}</span>)}
        </div>
        {rows.map((r, ri) => (
          <div key={r} className="rp-heat-row">
            <span className="rp-heat-label" title={r}>{r}</span>
            {values[ri].map((v, ci) => (
              <span
                key={ci}
                className={`rp-heat-cell ${hover && hover.r === ri && hover.c === ci ? 'hot' : ''}`}
                style={{ opacity: v ? 0.15 + 0.85 * (v / max) : 0.04 }}
                onMouseEnter={() => setHover({ r: ri, c: ci })}
              >
                {hover && hover.r === ri && hover.c === ci ? v : ''}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// Funnel — ordered lifecycle stages as centred, narrowing bars.
export function Funnel({ data }) {
  if (!data?.length) return <div className="rp-empty">No data</div>;
  const first = Math.max(1, data[0].value);
  return (
    <div className="rp-funnel">
      {data.map((d, i) => (
        <div key={d.label} className="rp-funnel-row" title={`${d.label}: ${d.value.toLocaleString()}`}>
          <div
            className="rp-funnel-bar"
            style={{
              width: `${Math.max(12, (d.value / first) * 100)}%`,
              background: `var(--rp-cat-${i % 6})`,
            }}
          >
            <span className="rp-funnel-val">{d.value.toLocaleString()}</span>
          </div>
          <span className="rp-funnel-label">
            {d.label} · {Math.round((d.value / first) * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}

// Scatter — one dot per item, with linear axes and hover tooltips.
export function Scatter({ data, xLabel = 'x', yLabel = 'y', height = 200 }) {
  if (!data?.length) return <div className="rp-empty">No data</div>;
  const w = 600;
  const padL = 34;
  const padB = 30;
  const padT = 10;
  const padR = 12;
  const maxX = Math.max(1, ...data.map((d) => d.x));
  const maxY = Math.max(1, ...data.map((d) => d.y));
  const x = (v) => padL + (v / maxX) * (w - padL - padR);
  const y = (v) => padT + (height - padT - padB) * (1 - v / maxY);
  const ticks = (max) => [0, Math.round(max / 2), max];
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="rp-scatter" role="img">
      <line x1={padL} y1={height - padB} x2={w - padR} y2={height - padB} className="rp-scatter-axis" />
      <line x1={padL} y1={padT} x2={padL} y2={height - padB} className="rp-scatter-axis" />
      {ticks(maxX).map((t) => (
        <text key={`x${t}`} x={x(t)} y={height - 8} textAnchor="middle" className="rp-scatter-tick">{t}</text>
      ))}
      {ticks(maxY).map((t) => (
        <text key={`y${t}`} x={padL - 6} y={y(t) + 3} textAnchor="end" className="rp-scatter-tick">{t}</text>
      ))}
      {data.map((d, i) => (
        <circle key={i} cx={x(d.x)} cy={y(d.y)} r="3.4" className="rp-scatter-dot">
          <title>{`${d.label}: ${d.x} ${xLabel}, ${d.y} ${yLabel}`}</title>
        </circle>
      ))}
    </svg>
  );
}

// Forecast chart — historical weekly actuals as a solid line, forecast mean as
// a dashed line, and the confidence interval as a shaded band. Hover reads out
// the value (with the CI range on forecast periods).
export function ForecastChart({ history, forecast, height = 240, labelEvery = 1 }) {
  const [active, setActive] = useState(null);
  const [wrapRef, mw] = useMeasuredWidth();
  if (!history?.length || !forecast?.points?.length) {
    return <div className="rp-empty">Not enough history to forecast</div>;
  }

  const all = [
    ...history.map((p) => ({ ...p, kind: 'actual' })),
    ...forecast.points.map((p) => ({ ...p, kind: 'forecast' })),
  ];
  const n = all.length;
  const w = mw;
  const padX = 8;
  const padTop = 12;
  const padBottom = 8;
  const max = Math.max(1, ...all.map((p) => p.hi ?? p.value));
  const innerW = w - padX * 2;
  const innerH = height - padTop - padBottom;
  const x = (i) => padX + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padTop + innerH - (v / max) * innerH;

  const hStart = history.length - 1; // forecast joins the last actual
  const base = padTop + innerH;
  const actualPath = smoothPath(history.map((p, i) => ({ x: x(i), y: y(p.value) })), padTop, base);
  const fcXY = [
    { x: x(hStart), y: y(history[hStart].value) },
    ...forecast.points.map((p, i) => ({ x: x(hStart + 1 + i), y: y(p.value) })),
  ];
  const fcPath = smoothPath(fcXY, padTop, base);
  // Band outline: joint → hi edge forward, jump to the far lo point, then the
  // lo edge backwards to the joint.
  const joint = { x: x(hStart), y: y(history[hStart].value) };
  const hiXY = [joint, ...forecast.points.map((p, i) => ({ x: x(hStart + 1 + i), y: y(p.hi) }))];
  const loReturn = [
    ...forecast.points.map((p, i) => ({ x: x(hStart + 1 + i), y: y(p.lo) })).reverse(),
    joint,
  ];
  const loPath = smoothPath(loReturn, padTop, base);
  const bandPath = `${smoothPath(hiXY, padTop, base)} L${loReturn[0].x.toFixed(2)},${loReturn[0].y.toFixed(2)} ${loPath.replace(/^M[^ ]+/, '').trim()} Z`;

  const every = Math.max(labelEvery, Math.ceil(n / Math.max(2, Math.floor(innerW / 80))));
  const shown = active != null ? all[active] : null;

  return (
    <div className="trend-wrap lc-wrap" ref={wrapRef}>
      <div className="trend-readout">
        {shown ? (
          <span className="trend-readout-cap">
            {shown.label} · {shown.kind === 'forecast'
              ? `predicted ${shown.value} (${shown.lo}–${shown.hi} @95%)`
              : `${shown.value} registered`}
          </span>
        ) : (
          <span className="trend-readout-cap">
            {history.length} weeks history · {forecast.points.length} weeks predicted · shaded = 95% interval
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        className="trend-svg"
        role="img"
        onMouseLeave={() => setActive(null)}
      >
        <path d={bandPath} className="fc-band" />
        <path d={actualPath} fill="none" className="lc-line" />
        <path d={fcPath} fill="none" className="lc-line lc-line-dashed" />
        {all.map((p, i) => (
          <g key={i}>
            <rect
              x={x(i) - innerW / n / 2}
              y={0}
              width={innerW / n}
              height={height}
              fill="transparent"
              onMouseEnter={() => setActive(i)}
            />
            {(active === i || p.kind === 'forecast') && (
              <circle
                cx={x(i)}
                cy={y(p.value)}
                r={active === i ? 4 : 2}
                className={`trend-dot ${p.kind === 'forecast' ? 'forecast' : ''} ${active === i ? 'active' : ''}`}
              />
            )}
          </g>
        ))}
      </svg>
      <div className="trend-labels">
        {all.map((p, i) => (
          <span key={i} className={active === i ? 'active' : ''}>
            {i % every === 0 ? p.label : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

// Pyramid — ordered buckets as centred bars scaled to the largest bucket,
// coloured along a severity ramp (calm → alarming). Suits ageing profiles.
const PYRAMID_RAMP = ['#1baf7a', '#eda100', '#e8720c', '#e34948', '#b91c1c'];
export function Pyramid({ data, colors = PYRAMID_RAMP }) {
  if (!data?.length) return <div className="rp-empty">No data</div>;
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return (
    <div className="rp-funnel">
      {data.map((d, i) => (
        <div
          key={d.label}
          className="rp-funnel-row"
          title={`${d.label}: ${d.value.toLocaleString()} (${Math.round((d.value / total) * 100)}% of open cases)`}
        >
          <div
            className="rp-funnel-bar"
            style={{
              width: `${Math.max(10, (d.value / max) * 100)}%`,
              background: colors[i % colors.length],
            }}
          >
            <span className="rp-funnel-val">{d.value.toLocaleString()}</span>
          </div>
          <span className="rp-funnel-label">
            {d.label} · {Math.round((d.value / total) * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}

// Horizontal bar list — for categories with long labels (legal sections,
// station names) where vertical columns would truncate the identity away.
export function HBarList({ data, format = (v) => v.toLocaleString(), suffix = '', percent = true }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  if (!data.length) return <div className="rp-empty">No data</div>;
  return (
    <div className="rp-bars">
      {data.map((d) => {
        const pct = Math.round((d.value / total) * 100);
        return (
          <div
            className="rp-bar-row"
            key={d.label}
            tabIndex={0}
            title={`${d.label}: ${format(d.value)}${suffix}${percent ? ` · ${pct}% of total` : ''}`}
          >
            <div className="rp-bar-label" title={d.label}>{d.label}</div>
            <div className="rp-bar-track">
              <div className="rp-bar-fill" style={{ width: `${Math.max(2, (d.value / max) * 100)}%` }} />
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
