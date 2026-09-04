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

// Straight polyline between points (no smoothing) — for charts where each
// data point should read literally rather than as a fitted curve.
const straightPath = (pts) =>
  pts.length ? 'M' + pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L') : '';

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
  const solidXY = xy(solid, 0);
  const dashedXY = xy(dashed, Math.max(0, fcStart - 1));
  const solidPath = straightPath(solidXY);
  const dashedPath = straightPath(dashedXY);
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
          {/* Series fade under the line, from the shared categorical slot 0. */}
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--rp-cat-0)" />
            <stop offset="48.25%" stopColor="var(--rp-cat-0)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--rp-cat-0)" stopOpacity="0" />
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
        {solid.length > 1 && <path d={solidPath} className="lc-line" fill="none" style={{ stroke: 'var(--rp-cat-0)' }} />}
        {dashed.length > 1 && <path d={dashedPath} className="lc-line lc-line-dashed" fill="none" style={{ stroke: 'var(--rp-cat-0)' }} />}
        {/* Data points on the line */}
        {solidXY.map((p, i) => (
          <circle key={`pt${i}`} cx={p.x} cy={p.y} r="2.6" className="lc-dot" style={{ fill: 'var(--rp-cat-0)' }} />
        ))}
        {dashedXY.slice(1).map((p, i) => (
          <circle key={`fpt${i}`} cx={p.x} cy={p.y} r="2.6" className="lc-dot lc-dot-forecast" style={{ stroke: 'var(--rp-cat-0)' }} />
        ))}
        {active != null && (
          <>
            <line x1={x(active)} x2={x(active)} y1={padT} y2={base} className="lc-cursor" />
            <circle cx={x(active)} cy={y(data[active].value)} r="4.5" className="lc-ring" style={{ stroke: 'var(--rp-cat-0)' }} />
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
            <span className="lc-tip-dot" style={{ background: 'var(--rp-cat-0)' }} />
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
  // Bars are drawn against the LARGEST stage, not the first one. A case
  // funnel is not monotonic — more cases can be chargesheeted this period
  // than were opened in it — so sizing on the first stage gave a 110% bar
  // that drew straight out through the side of the card. The percentage
  // beside each bar still reads against the first stage, because that ratio
  // is the thing a funnel is for; only the geometry is normalised.
  const widest = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="rp-funnel">
      {data.map((d, i) => (
        <div key={d.label} className="rp-funnel-row" title={`${d.label}: ${d.value.toLocaleString()}`}>
          <div
            className="rp-funnel-bar"
            style={{
              width: `${Math.min(100, Math.max(12, (d.value / widest) * 100))}%`,
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

// Forecast chart — historical actuals as a solid line, forecast mean as a
// dashed line, and the confidence interval as a shaded band.
//
// Hovering reads out ON the chart: a crosshair down the period under the
// cursor and a card beside it carrying the value, and the 95% interval when
// the period is a prediction. It used to put that text in a caption line ABOVE
// the plot, which meant reading a value required looking away from the point
// you were pointing at — and on a wide card that was most of the screen's
// width away.
//
// Both axes are drawn: a y scale to a nice ceiling with dashed gridlines, and
// x ticks under the plot at the periods they belong to. Before this the chart
// had neither — the y extent was unlabelled, so a reader could see the shape
// of a forecast but not the size of it, and the x labels sat in a flex row
// underneath that spread them evenly rather than putting them beneath their
// own points.
//
// `unit` names the time bucket in the caption and the axis titles. The
// crime-volume forecasts are monthly; anything still passing weekly series
// keeps the old wording.
const FC_AXIS = {
  months: { x: 'Month', y: 'FIRs per month' },
  weeks: { x: 'Week', y: 'FIRs per week' },
};

export function ForecastChart({ history, forecast, height = 240, unit = 'weeks' }) {
  const [active, setActive] = useState(null);
  const [wrapRef, mw] = useMeasuredWidth();
  if (!history?.length || !forecast?.points?.length) {
    return <div className="rp-empty">Not enough history to forecast</div>;
  }

  const axis = FC_AXIS[unit] || FC_AXIS.weeks;
  const all = [
    ...history.map((p) => ({ ...p, kind: 'actual' })),
    ...forecast.points.map((p) => ({ ...p, kind: 'forecast' })),
  ];
  const n = all.length;
  const w = mw;
  // Left room for the y ticks and their rotated title; bottom room for the x
  // ticks and theirs.
  const padL = 54;
  const padR = 14;
  const padTop = 12;
  const padBottom = 44;
  // The band, not the mean, sets the top of the scale — a ceiling that clipped
  // the interval would understate the uncertainty the band exists to show.
  const max = niceCeil(Math.max(1, ...all.map((p) => p.hi ?? p.value)));
  const innerW = w - padL - padR;
  const innerH = height - padTop - padBottom;
  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
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

  // Label density is a function of the width available, not of the caller:
  // roughly one tick per 72px, so a narrow card thins them out on its own.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 72))));
  const shown = active != null ? all[active] : null;

  /* The card sits beside the cursor, never under it: to the right on the left
     half of the plot, to the left on the right half, so it can never cover the
     point being read. */
  const tipStyle = active == null ? null
    : x(active) < w / 2
      ? { left: x(active) + 14 }
      : { left: x(active) - 14, transform: 'translateX(-100%)' };

  return (
    <div className="trend-wrap lc-wrap" ref={wrapRef}>
      <div className="trend-readout">
        <span className="trend-readout-cap">
          {history.length} {unit} history · {forecast.points.length} {unit} predicted · shaded = 95% interval
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        className="trend-svg"
        role="img"
        aria-label={`${axis.y} — ${history.length} ${unit} of history and ${forecast.points.length} ${unit} forecast`}
        onMouseLeave={() => setActive(null)}
      >
        {/* y axis: dashed gridlines with their values, over a solid spine */}
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={w - padR} y1={y(max * f)} y2={y(max * f)} className="col-grid" />
            <text x={padL - 8} y={y(max * f) + 4} textAnchor="end" className="col-tick">
              {fmtTick(max * f)}
            </text>
          </g>
        ))}
        <text x={padL - 8} y={base + 4} textAnchor="end" className="col-tick">0</text>
        <line x1={padL} x2={padL} y1={padTop} y2={base} className="col-grid col-grid-base" />
        <line x1={padL} x2={w - padR} y1={base} y2={base} className="col-grid col-grid-base" />
        <text
          className="col-axis-title"
          textAnchor="middle"
          transform={`translate(12,${padTop + innerH / 2}) rotate(-90)`}
        >
          {axis.y}
        </text>

        <path d={bandPath} className="fc-band" />
        {/* Where measurement stops and prediction starts, on the x axis. */}
        <line x1={x(hStart)} x2={x(hStart)} y1={padTop} y2={base} className="col-grid fc-split" />
        <path d={actualPath} fill="none" className="lc-line" />
        <path d={fcPath} fill="none" className="lc-line lc-line-dashed" />
        {active != null && (
          <line
            x1={x(active)} x2={x(active)} y1={padTop} y2={base}
            className="lc-cursor"
          />
        )}
        {all.map((p, i) => (
          <g key={i}>
            <rect
              x={x(i) - innerW / n / 2}
              y={0}
              width={innerW / n}
              height={base}
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

        {/* x axis: a tick under the period it belongs to, thinned to fit */}
        {all.map((p, i) => (
          i % every === 0 ? (
            <text
              key={`x${i}`}
              x={x(i)}
              y={base + 18}
              textAnchor="middle"
              className={`col-label ${active === i ? 'active' : ''}`}
            >
              {p.label}
            </text>
          ) : null
        ))}
        <text x={padL + innerW / 2} y={height - 4} textAnchor="middle" className="col-axis-title">
          {axis.x}
        </text>
      </svg>
      {shown && (
        <div className="lc-tip fc-tip" style={tipStyle}>
          <div className="lc-tip-title">
            {shown.label}{shown.kind === 'forecast' ? ' · projected' : ''}
          </div>
          <div className="lc-tip-row">
            <span className="lc-tip-dot" style={{ background: 'var(--rp-cat-0)' }} />
            <span className="lc-tip-name">
              {shown.kind === 'forecast' ? 'Predicted' : 'Registered'}
            </span>
            <b>{shown.value.toLocaleString()}</b>
          </div>
          {shown.kind === 'forecast' && shown.lo != null && (
            <div className="lc-tip-row lc-tip-total">
              <span className="lc-tip-name">95% interval</span>
              <b>{shown.lo.toLocaleString()}–{shown.hi.toLocaleString()}</b>
            </div>
          )}
        </div>
      )}
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
              width: `${Math.min(100, Math.max(10, (d.value / max) * 100))}%`,
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
              <div className="rp-bar-fill" style={{ width: `${Math.min(100, Math.max(2, (d.value / max) * 100))}%` }} />
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


/**
 * Stacked bars — one bar per category, split into named series.
 *
 * `data` is [{ label, parts: [{ name, value }] }]. Series colours come from the
 * same --rp-cat ramp the line charts use, so a series keeps its colour when the
 * assistant answers the same question two ways.
 *
 * The total sits above each bar because that is what a stacked chart is
 * usually read for — the composition is the detail, the total is the headline.
 */
export function StackedBars({ data, height = 220, format = (v) => v.toLocaleString() }) {
  const [hover, setHover] = useState(null); // { bar, part }
  const rows = (Array.isArray(data) ? data : [])
    .map((d) => ({
      label: String(d.label ?? ''),
      parts: (Array.isArray(d.parts) ? d.parts : [])
        // Number(null) is 0 and 0 is finite, so an explicit check is needed or
        // a missing figure draws as a zero-height segment that reads as "none".
        .filter((p) => p && p.value !== null && p.value !== undefined && p.value !== ''
          && typeof p.value !== 'boolean' && Number.isFinite(Number(p.value)))
        .map((p) => ({ name: String(p.name ?? ''), value: Math.max(0, Number(p.value)) })),
    }))
    .filter((d) => d.parts.length);
  if (!rows.length) return <div className="rp-empty">No data</div>;

  // One colour per distinct series name, assigned in first-seen order so the
  // legend and the stack agree.
  const names = [];
  for (const r of rows) for (const p of r.parts) if (!names.includes(p.name)) names.push(p.name);
  const colourOf = (name) => `var(--rp-cat-${names.indexOf(name) % 6})`;

  const totals = rows.map((r) => r.parts.reduce((a, p) => a + p.value, 0));
  const max = Math.max(1, ...totals);

  return (
    <div className="rp-stack">
      <div className="rp-stack-legend">
        {names.map((n) => (
          <span key={n}><i style={{ background: colourOf(n) }} />{n}</span>
        ))}
      </div>
      <div className="rp-stack-plot" style={{ height }} onMouseLeave={() => setHover(null)}>
        {rows.map((r, bi) => (
          <div key={r.label} className="rp-stack-col">
            <span className="rp-stack-total">{format(totals[bi])}</span>
            <div className="rp-stack-bar" style={{ height: `${(totals[bi] / max) * 100}%` }}>
              {r.parts.map((p, pi) => (
                <div
                  key={p.name}
                  className={`rp-stack-seg${hover && hover.bar === bi && hover.part === pi ? ' on' : ''}`}
                  style={{
                    height: `${totals[bi] ? (p.value / totals[bi]) * 100 : 0}%`,
                    background: colourOf(p.name),
                  }}
                  onMouseEnter={() => setHover({ bar: bi, part: pi })}
                  title={`${r.label} · ${p.name}: ${format(p.value)}`}
                />
              ))}
            </div>
            <span className="rp-stack-label">{r.label}</span>
          </div>
        ))}
      </div>
      {hover && (
        <div className="rp-stack-read">
          <b>{rows[hover.bar].label}</b>
          <span>{rows[hover.bar].parts[hover.part].name}</span>
          <b>{format(rows[hover.bar].parts[hover.part].value)}</b>
        </div>
      )}
    </div>
  );
}

/**
 * Sankey — where quantity flows from and to.
 *
 * `nodes` is [{ id, label }] and `links` is [{ source, target, value }].
 *
 * Layered rather than force-directed: depth is computed by walking forward from
 * the nodes nothing flows into, which is what makes a Sankey readable — money
 * or cases move left to right and a reader can follow one ribbon the whole way.
 * A cycle would make that walk infinite, so depth is capped; the alternative,
 * refusing to draw, would hide the very thing worth seeing in a laundering
 * chain that loops back on itself.
 */
export function Sankey({ nodes, links, height = 300, format = (v) => v.toLocaleString() }) {
  const [hover, setHover] = useState(null);
  const [wrapRef, mw] = useMeasuredWidth();

  const nodeList = (Array.isArray(nodes) ? nodes : [])
    .filter((n) => n && n.id != null)
    .map((n) => ({ id: String(n.id), label: String(n.label ?? n.id) }));
  const byId = new Map(nodeList.map((n) => [n.id, n]));
  const flows = (Array.isArray(links) ? links : [])
    .filter((l) => l && byId.has(String(l.source)) && byId.has(String(l.target))
      && l.value !== null && l.value !== undefined && l.value !== ''
      && Number.isFinite(Number(l.value)) && Number(l.value) > 0
      && String(l.source) !== String(l.target))
    .map((l) => ({ source: String(l.source), target: String(l.target), value: Number(l.value) }));
  if (!nodeList.length || !flows.length) return <div className="rp-empty">No data</div>;

  // Depth: 0 for anything with no inflow, otherwise one past its deepest
  // source. Capped so a cycle terminates rather than spinning.
  const depth = new Map(nodeList.map((n) => [n.id, 0]));
  const incoming = new Set(flows.map((f) => f.target));
  for (let pass = 0; pass < Math.min(nodeList.length, 12); pass++) {
    let moved = false;
    for (const f of flows) {
      const want = depth.get(f.source) + 1;
      if (want > depth.get(f.target)) { depth.set(f.target, want); moved = true; }
    }
    if (!moved) break;
  }
  for (const n of nodeList) if (!incoming.has(n.id)) depth.set(n.id, 0);

  const maxDepth = Math.max(...[...depth.values()]);
  const columns = [];
  for (let d = 0; d <= maxDepth; d++) columns.push(nodeList.filter((n) => depth.get(n.id) === d));

  // A node is as tall as the larger of what enters and what leaves it.
  const through = (id) => Math.max(
    flows.filter((f) => f.target === id).reduce((a, f) => a + f.value, 0),
    flows.filter((f) => f.source === id).reduce((a, f) => a + f.value, 0),
  );
  const colTotal = columns.map((c) => c.reduce((a, n) => a + through(n.id), 0) || 1);
  const scale = Math.max(...colTotal);

  const w = mw || 640;
  const padX = 4;
  const nodeW = 12;
  const gap = 10;
  const colX = (d) => padX + (d * (w - padX * 2 - nodeW)) / Math.max(1, maxDepth);

  // Vertical placement, stacked within each column.
  const box = new Map();
  columns.forEach((col, d) => {
    const avail = height - gap * Math.max(0, col.length - 1);
    let y = 0;
    for (const n of col) {
      const h = Math.max(3, (through(n.id) / scale) * avail);
      box.set(n.id, { x: colX(d), y, h, d });
      y += h + gap;
    }
  });

  // Ribbons leave and arrive stacked in the same order, so they do not cross
  // themselves within a node.
  const outAt = new Map();
  const inAt = new Map();
  const ribbons = flows.map((f, i) => {
    const a = box.get(f.source);
    const b = box.get(f.target);
    const aTotal = flows.filter((x) => x.source === f.source).reduce((s, x) => s + x.value, 0) || 1;
    const bTotal = flows.filter((x) => x.target === f.target).reduce((s, x) => s + x.value, 0) || 1;
    const ah = (f.value / aTotal) * a.h;
    const bh = (f.value / bTotal) * b.h;
    const ay = a.y + (outAt.get(f.source) || 0);
    const by = b.y + (inAt.get(f.target) || 0);
    outAt.set(f.source, (outAt.get(f.source) || 0) + ah);
    inAt.set(f.target, (inAt.get(f.target) || 0) + bh);
    const x1 = a.x + nodeW;
    const x2 = b.x;
    const mx = (x1 + x2) / 2;
    return {
      i,
      flow: f,
      colour: `var(--rp-cat-${a.d % 6})`,
      d: `M${x1},${ay} C${mx},${ay} ${mx},${by} ${x2},${by} L${x2},${by + bh} C${mx},${by + bh} ${mx},${ay + ah} ${x1},${ay + ah} Z`,
    };
  });

  return (
    <div className="rp-sankey" ref={wrapRef}>
      <svg width="100%" height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none">
        {ribbons.map((r) => (
          <path
            key={r.i}
            d={r.d}
            fill={r.colour}
            className={`rp-sankey-flow${hover === r.i ? ' on' : ''}`}
            onMouseEnter={() => setHover(r.i)}
            onMouseLeave={() => setHover(null)}
          >
            <title>{`${byId.get(r.flow.source).label} → ${byId.get(r.flow.target).label}: ${format(r.flow.value)}`}</title>
          </path>
        ))}
        {nodeList.map((n) => {
          const b = box.get(n.id);
          return (
            <rect
              key={n.id}
              x={b.x} y={b.y} width={nodeW} height={b.h}
              rx="2"
              fill={`var(--rp-cat-${b.d % 6})`}
              className="rp-sankey-node"
            >
              <title>{`${n.label}: ${format(through(n.id))}`}</title>
            </rect>
          );
        })}
      </svg>
      {/* Labels in HTML rather than SVG text: they wrap, they inherit the
          page's font stack, and a Kannada node name renders with the right
          fallback face instead of tofu. */}
      <div className="rp-sankey-labels">
        {nodeList.map((n) => {
          const b = box.get(n.id);
          return (
            <span
              key={n.id}
              className="rp-sankey-label"
              style={{
                left: `${((b.x + (b.d === maxDepth ? -4 : nodeW + 4)) / w) * 100}%`,
                top: b.y + b.h / 2,
                transform: `translateY(-50%)${b.d === maxDepth ? ' translateX(-100%)' : ''}`,
              }}
            >
              {n.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
