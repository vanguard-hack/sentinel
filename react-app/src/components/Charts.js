import React, { useState, useMemo } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';

// Area trend — one series over ordered periods (e.g. cases per month). SVG with
// a filled area under the line; hovering (or focusing) a period highlights its
// dot and shows value + label in the header readout. Colours come from the
// validated viz tokens (--rp-series), so it adapts to theme automatically.
export function TrendArea({ data, height = 150 }) {
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

  const linePts = data.map((d, i) => `${x(i)},${y(d.value)}`).join(' ');
  const areaPts = `${padX},${padTop + innerH} ${linePts} ${padX + innerW},${padTop + innerH}`;

  const shown = active != null ? data[active] : null;
  const totalVal = data.reduce((s, d) => s + d.value, 0);

  return (
    <div className="trend-wrap">
      <div className="trend-readout">
        <span className="trend-readout-value">
          {(shown ? shown.value : totalVal).toLocaleString()}
        </span>
        <span className="trend-readout-cap">
          {shown ? shown.label : `total · ${data.length} periods`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        className="trend-svg"
        role="img"
        preserveAspectRatio="none"
        onMouseLeave={() => setActive(null)}
      >
        <polygon points={areaPts} className="trend-area" />
        <polyline points={linePts} className="trend-line" fill="none" />
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
              className={`trend-dot ${active === i ? 'active' : ''}`}
            />
          </g>
        ))}
      </svg>
      <div className="trend-labels">
        {data.map((d, i) => (
          <span key={i} className={active === i ? 'active' : ''}>{d.label}</span>
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

  const size = 168;
  const stroke = 26;
  const c = size / 2;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const gap = data.length > 1 ? 2 : 0;

  let offset = 0;
  const segs = data.map((d, i) => {
    const len = (d.value / total) * circ;
    const seg = { i, len, offset };
    offset += len;
    return seg;
  });

  const shown = active != null ? data[active] : null;
  const centerMain = shown ? shown.value.toLocaleString() : total.toLocaleString();
  const centerCap = shown ? `${Math.round((shown.value / total) * 100)}% · ${shown.label}` : 'total';

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
                  strokeWidth={isActive ? stroke + 5 : stroke}
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
          <span className="rp-donut-total">{centerMain}</span>
          <span className="rp-donut-cap">{centerCap}</span>
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
