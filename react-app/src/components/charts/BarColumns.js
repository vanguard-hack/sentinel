/* ═══════════════════════════════════════════════════════════════════════════
   BarColumns — vertical bars

   Replaces the Charts.js BarList. Same props, so it is a drop-in.

   The Bklit treatment applied to a bar chart: the same faded dashed grid, a
   vertical fill fade rather than a flat block, bars that grow from the
   baseline once on first paint, and a hover that drops the set back so the
   bar under the cursor is the only one at full strength.

   Long category labels are the reason this chart is not simply the line chart
   with different marks — it angles them when they would otherwise collide,
   which is a layout decision the upstream demo never has to make.
   ═══════════════════════════════════════════════════════════════════════════ */

import React, { useMemo, useState } from 'react';
import { ParentSize } from '@visx/responsive';
import { scaleLinear } from '@visx/scale';
import {
  DIM, DRAW_MS, EASE, cat, fmtTick, useChartId, useDrawOn, FillFade, FadedGrid, Tip,
} from './primitives';
import './chart-tokens.css';

function Plot({
  width, height, data, format, suffix, percent, straightLabels, caption, ariaLabel,
}) {
  const [active, setActive] = useState(null);
  const uid = useChartId();
  const drawn = useDrawOn(width > 0);

  const n = data.length;
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const longest = Math.max(...data.map((d) => String(d.label).length));
  const angled = !straightLabels && (longest > 7 || n > 8);

  const M = { top: 10, right: 12, bottom: angled ? 54 : 28, left: 40 };
  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = Math.max(0, height - M.top - M.bottom);

  const maxV = useMemo(() => Math.max(1, ...data.map((d) => d.value)), [data]);
  const yScale = useMemo(
    () => scaleLinear({ range: [innerH, 0], domain: [0, maxV], nice: true }),
    [innerH, maxV]
  );

  if (innerW <= 0) return null;

  const slot = innerW / n;
  const barW = Math.min(56, slot * 0.62);

  return (
    <>
      <svg
        className="bk-chart-svg"
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        onMouseLeave={() => setActive(null)}
      >
        {/* Solid at the baseline, lighter at the tip. A bar is measured from
            its base, so that is the end that must stay anchored — fading it
            there is what made these look like they were floating on the light
            canvas. */}
        <defs><FillFade id={`fl-${uid}`} color={cat(0)} top={0.72} bottom={1} /></defs>
        <g transform={`translate(${M.left},${M.top})`}>
          <FadedGrid
            id={`g-${uid}`}
            ticks={yScale.ticks(5)}
            y={yScale}
            width={innerW}
            height={innerH}
          />
          {yScale.ticks(5).map((t) => (
            <text key={t} className="bk-chart-tick" x={-8} y={yScale(t) + 3} textAnchor="end">
              {fmtTick(t)}
            </text>
          ))}

          {data.map((d, i) => {
            const x = i * slot + (slot - barW) / 2;
            const y = yScale(d.value);
            const h = Math.max(1, innerH - y);
            const dim = active != null && active !== i;
            return (
              <g key={`${d.label}-${i}`} onMouseEnter={() => setActive(i)}>
                {/* Full-height hit area: a short bar is otherwise almost
                    impossible to point at. */}
                <rect x={i * slot} y={0} width={slot} height={innerH} fill="transparent" />
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={4}
                  fill={`url(#fl-${uid})`}
                  opacity={dim ? DIM : 1}
                  style={{
                    transformOrigin: `0px ${innerH}px`,
                    transform: drawn ? 'scaleY(1)' : 'scaleY(0)',
                    transition: `${drawn ? `transform ${DRAW_MS}ms ${EASE}, ` : ''}opacity 0.25s ease`,
                  }}
                />
              </g>
            );
          })}

          {data.map((d, i) => {
            const cx = i * slot + slot / 2;
            return angled ? (
              <text
                key={`${d.label}-l${i}`}
                className="bk-chart-tick"
                x={cx}
                y={innerH + 12}
                textAnchor="end"
                transform={`rotate(-38 ${cx} ${innerH + 12})`}
              >
                {d.label}
              </text>
            ) : (
              <text
                key={`${d.label}-l${i}`}
                className="bk-chart-tick"
                x={cx}
                y={innerH + 18}
                textAnchor="middle"
              >
                {d.label}
              </text>
            );
          })}
        </g>
      </svg>

      {active != null && data[active] && (
        <Tip
          x={active * slot + slot / 2 + M.left}
          width={width}
          title={data[active].label}
          rows={[{
            name: caption === false ? 'Value' : 'Count',
            value: `${format(data[active].value)}${suffix}${
              percent ? ` · ${Math.round((data[active].value / total) * 100)}%` : ''
            }`,
            color: cat(0),
          }]}
        />
      )}
    </>
  );
}

export default function BarColumns({
  data,
  format = (v) => v.toLocaleString(),
  suffix = '',
  percent = true,
  height = 215,
  straightLabels = false,
  caption = true,
  ariaLabel = 'Bar chart',
}) {
  if (!data || !data.length) return <div className="rp-empty">No data</div>;
  return (
    <div className="bk-chart" style={{ height }}>
      <ParentSize debounceTime={0}>
        {({ width }) =>
          width < 10 ? null : (
            <Plot
              width={width}
              height={height}
              data={data}
              format={format}
              suffix={suffix}
              percent={percent}
              straightLabels={straightLabels}
              caption={caption}
              ariaLabel={ariaLabel}
            />
          )
        }
      </ParentSize>
    </div>
  );
}

export { Plot };
