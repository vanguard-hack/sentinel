import React, { useState, useMemo } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';

// Area trend — one series over ordered periods (e.g. cases per month). SVG with
// a filled area under the line; hovering (or focusing) a period highlights its
// dot and shows value + label in the header readout. Colours come from the
// validated viz tokens (--rp-series), so it adapts to theme automatically.
// `labelEvery` thins the x-axis labels for dense series (hours, days).
// Points flagged `forecast: true` (must be a suffix of the series) render as a
// dashed line segment with hollow dots — visually distinct from observations.
export function TrendArea({ data, height = 150, labelEvery = 1 }) {
  const [active, setActive] = useState(null);
  if (!data || !data.length) return <div className="rp-empty">No data</div>;

  const w = 600;
  const padX = 8;
  const padTop = 12;
  const padBottom = 22;
  const max = Math.max(1, ...data.map((d) => d.value));
  const innerW = w - padX * 2;
  const innerH = height - padTop - padBottom;
  const x = (i) => padX + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v) => padTop + innerH - (v / max) * innerH;

  const fcStart = data.findIndex((d) => d.forecast);
  const solid = fcStart === -1 ? data : data.slice(0, fcStart);
  // The dashed segment starts at the last observed point for continuity.
  const dashed = fcStart === -1 ? [] : data.slice(Math.max(0, fcStart - 1));

  const pts = (arr, offset) => arr.map((d, i) => `${x(i + offset)},${y(d.value)}`).join(' ');
  const solidPts = pts(solid, 0);
  const dashedPts = pts(dashed, fcStart === -1 ? 0 : Math.max(0, fcStart - 1));
  const areaPts = `${padX},${padTop + innerH} ${pts(solid, 0)} ${x(solid.length - 1)},${padTop + innerH}`;

  const shown = active != null ? data[active] : null;
  const totalVal = data.filter((d) => !d.forecast).reduce((s, d) => s + d.value, 0);

  return (
    <div className="trend-wrap">
      <div className="trend-readout">
        <span className="trend-readout-value">
          {(shown ? shown.value : totalVal).toLocaleString()}
        </span>
        <span className="trend-readout-cap">
          {shown
            ? `${shown.label}${shown.forecast ? ' · projected' : ''}`
            : `total · ${data.filter((d) => !d.forecast).length} periods`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        className="trend-svg"
        role="img"
        preserveAspectRatio="none"
        onMouseLeave={() => setActive(null)}
      >
        {solid.length > 1 && <polygon points={areaPts} className="trend-area" />}
        {solid.length > 1 && <polyline points={solidPts} className="trend-line" fill="none" />}
        {dashed.length > 1 && (
          <polyline points={dashedPts} className="trend-line trend-line-forecast" fill="none" />
        )}
        {data.map((d, i) => (
          <g key={i}>
            {/* generous invisible hit target per period */}
            <rect
              x={x(i) - innerW / data.length / 2}
              y={0}
              width={innerW / data.length}
              height={height}
              fill="transparent"
              onMouseEnter={() => setActive(i)}
            />
            <circle
              cx={x(i)}
              cy={y(d.value)}
              r={active === i ? 4.5 : 2.5}
              className={`trend-dot ${d.forecast ? 'forecast' : ''} ${active === i ? 'active' : ''}`}
            />
          </g>
        ))}
      </svg>
      <div className="trend-labels">
        {data.map((d, i) => (
          <span key={i} className={active === i ? 'active' : ''}>
            {i % labelEvery === 0 ? d.label : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

// Horizontal bar list — single-series magnitude. One hue (identity is the row
// label, so no legend); every bar carries a direct value label. Interactive:
// a segmented sort control (desc / asc) and per-bar hover that reveals the share
// of total. Pass percent={false} when the value is already a percentage.
export function BarList({ data, format = (v) => v.toLocaleString(), suffix = '', percent = true }) {
  const [dir, setDir] = useState('desc');

  // Sort every row — including any "Other" bucket — by the chosen direction.
  const sorted = useMemo(
    () => [...data].sort((a, b) => (dir === 'desc' ? b.value - a.value : a.value - b.value)),
    [data, dir]
  );

  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  if (!data.length) return <div className="rp-empty">No data</div>;

  return (
    <div>
      <div className="rp-bar-toolbar">
        <button
          className="rp-sort-btn"
          onClick={() => setDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
          aria-label={`Sorted ${dir === 'desc' ? 'descending' : 'ascending'} — click to flip`}
          title={dir === 'desc' ? 'Sorted high → low' : 'Sorted low → high'}
        >
          {dir === 'desc' ? <ArrowDown size={16} /> : <ArrowUp size={16} />}
        </button>
      </div>
      <div className="rp-bars">
        {sorted.map((d) => {
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
                <div
                  className="rp-bar-fill"
                  style={{ width: `${Math.max(2, (d.value / max) * 100)}%` }}
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
  const gap = 0; // seamless ring — no visible cuts between slices

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
              const dash = Math.max(0.001, s.len - gap);
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

// Multi-line trend — several series over the same ordered periods. Colours use
// the categorical slots; a legend beneath carries identity. Hovering a period
// column reads out every series' value for it.
export function MultiLine({ series, height = 170, labelEvery = 1 }) {
  const [active, setActive] = useState(null);
  const rows = (series || []).filter((s) => s.points && s.points.length);
  if (!rows.length) return <div className="rp-empty">No data</div>;

  const n = rows[0].points.length;
  const w = 600;
  const padX = 8;
  const padTop = 12;
  const padBottom = 8;
  const max = Math.max(1, ...rows.flatMap((s) => s.points.map((p) => p.value)));
  const innerW = w - padX * 2;
  const innerH = height - padTop - padBottom;
  const x = (i) => padX + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padTop + innerH - (v / max) * innerH;

  return (
    <div className="trend-wrap">
      <div className="trend-readout">
        {active != null ? (
          <span className="trend-readout-cap">
            {rows[0].points[active].label} ·{' '}
            {rows.map((s) => `${s.name}: ${s.points[active].value}`).join(' · ')}
          </span>
        ) : (
          <span className="trend-readout-cap">{n} periods · hover for values</span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        className="trend-svg"
        preserveAspectRatio="none"
        role="img"
        onMouseLeave={() => setActive(null)}
      >
        {active != null && (
          <line x1={x(active)} x2={x(active)} y1={padTop} y2={padTop + innerH} className="ml-cursor" />
        )}
        {rows.map((s, si) => (
          <polyline
            key={s.name}
            fill="none"
            points={s.points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')}
            style={{ stroke: `var(--rp-cat-${si % 6})`, strokeWidth: 1.8 }}
          />
        ))}
        {rows.map((s, si) =>
          s.points.map((p, i) => (
            <circle
              key={`${si}-${i}`}
              cx={x(i)}
              cy={y(p.value)}
              r={active === i ? 3.4 : 1.6}
              style={{ fill: `var(--rp-cat-${si % 6})` }}
            />
          ))
        )}
        {rows[0].points.map((p, i) => (
          <rect
            key={i}
            x={x(i) - innerW / n / 2}
            y={0}
            width={innerW / n}
            height={height}
            fill="transparent"
            onMouseEnter={() => setActive(i)}
          />
        ))}
      </svg>
      <div className="trend-labels">
        {rows[0].points.map((p, i) => (
          <span key={i} className={active === i ? 'active' : ''}>
            {i % labelEvery === 0 ? p.label : ''}
          </span>
        ))}
      </div>
      <ul className="rp-legend rp-legend-row">
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
export function HeatGrid({ rows, cols, values }) {
  if (!rows?.length) return <div className="rp-empty">No data</div>;
  const max = Math.max(1, ...values.flat());
  return (
    <div className="rp-heat">
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
              className="rp-heat-cell"
              style={{ opacity: v ? 0.15 + 0.85 * (v / max) : 0.04 }}
              title={`${r} · ${cols[ci]}: ${v}`}
            />
          ))}
        </div>
      ))}
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
  const padB = 24;
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
export function ForecastChart({ history, forecast, height = 190, labelEvery = 1 }) {
  const [active, setActive] = useState(null);
  if (!history?.length || !forecast?.points?.length) {
    return <div className="rp-empty">Not enough history to forecast</div>;
  }

  const all = [
    ...history.map((p) => ({ ...p, kind: 'actual' })),
    ...forecast.points.map((p) => ({ ...p, kind: 'forecast' })),
  ];
  const n = all.length;
  const w = 600;
  const padX = 8;
  const padTop = 12;
  const padBottom = 8;
  const max = Math.max(1, ...all.map((p) => p.hi ?? p.value));
  const innerW = w - padX * 2;
  const innerH = height - padTop - padBottom;
  const x = (i) => padX + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padTop + innerH - (v / max) * innerH;

  const hStart = history.length - 1; // forecast joins the last actual
  const actualPts = history.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  const fcPts = [
    `${x(hStart)},${y(history[hStart].value)}`,
    ...forecast.points.map((p, i) => `${x(hStart + 1 + i)},${y(p.value)}`),
  ].join(' ');
  const band = [
    `${x(hStart)},${y(history[hStart].value)}`,
    ...forecast.points.map((p, i) => `${x(hStart + 1 + i)},${y(p.hi)}`),
    ...forecast.points.map((p, i) => `${x(hStart + forecast.points.length - i)},${y(forecast.points[forecast.points.length - 1 - i].lo)}`),
  ].join(' ');

  const shown = active != null ? all[active] : null;

  return (
    <div className="trend-wrap">
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
        preserveAspectRatio="none"
        role="img"
        onMouseLeave={() => setActive(null)}
      >
        <polygon points={band} className="fc-band" />
        <polyline points={actualPts} fill="none" className="trend-line" />
        <polyline points={fcPts} fill="none" className="trend-line trend-line-forecast" />
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
            {i % labelEvery === 0 ? p.label : ''}
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
