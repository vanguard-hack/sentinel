/* ═══════════════════════════════════════════════════════════════════════════
   TrendArea — single-series area chart

   The companion to TrendLine: the Crime trend card switches between them
   depending on whether the window spans multiple years. Vendored from Bklit
   UI's area chart (MIT, Copyright (c) 2026 uixmat) and adapted the same way —
   generic over the app's { label, value } points, no Tailwind, colours from
   the shared ramp.

   Carries one thing the line chart does not: some callers mark trailing
   points with `forecast: true`, and a forecast must not look like a
   measurement. Those are drawn dashed and with no fill under them.
   ═══════════════════════════════════════════════════════════════════════════ */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { curveNatural } from '@visx/curve';
import { ParentSize } from '@visx/responsive';
import { scaleLinear } from '@visx/scale';
import { AreaClosed, LinePath } from '@visx/shape';
import { motion, useSpring } from 'motion/react';
import {
  DRAW_MS, EASE, SPRING, cat, fmtTick, useChartId, useDrawOn, EdgeFade, FillFade, FadedGrid, Tip,
} from './primitives';
import './chart-tokens.css';

const MARGIN = { top: 12, right: 16, bottom: 28, left: 40 };

// A forecast tail is a different kind of claim from a measurement, so it is
// drawn dashed and carries no fill. A LEADING run of `illustrative: true`
// points (a placeholder backdrop with no real record behind it — e.g. the
// Temporal Patterns yearly chart's pre-dataset years) gets the same dashed,
// no-fill treatment for the same reason, symmetrically at the other end.
// Both are optional: a caller that sets neither flag gets back exactly the
// solid-only rendering this chart has always had. Two separate dashed runs,
// never concatenated into one: they are not adjacent in x-index, and a
// single path between them would draw a spurious line straight across the
// solid segment.
export function trendSegments(data) {
  const fcStart = data.findIndex((d) => d.forecast);
  let illEnd = data.findIndex((d) => !d.illustrative); // count of leading illustrative points
  if (illEnd === -1) illEnd = data.length; // every point flagged illustrative — treat it all as the lead-in
  const hasLead = illEnd > 0;
  const hasTrail = fcStart !== -1;
  const idx = data.map((d, i) => ({ i, value: d.value ?? 0 }));
  const solid = idx.slice(illEnd, hasTrail ? fcStart : idx.length);
  // Each dashed run overlaps the solid segment by one point so its line
  // visually joins where the solid line starts/ends.
  const leadDashed = hasLead ? idx.slice(0, Math.min(idx.length, illEnd + 1)) : [];
  const trailDashed = hasTrail ? idx.slice(Math.max(0, fcStart - 1)) : [];
  return { solid, leadDashed, trailDashed };
}

function Plot({ width, height, data, ariaLabel }) {
  const [active, setActive] = useState(null);
  const svgRef = useRef(null);
  const uid = useChartId();
  const drawn = useDrawOn(width > 0);

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const n = data.length;

  const maxV = useMemo(() => Math.max(1, ...data.map((d) => d.value ?? 0)), [data]);
  const xScale = useMemo(
    () => scaleLinear({ range: [0, innerW], domain: [0, Math.max(1, n - 1)] }),
    [innerW, n]
  );
  const yScale = useMemo(
    () => scaleLinear({ range: [innerH, 0], domain: [0, maxV], nice: true }),
    [innerH, maxV]
  );

  const cursorX = useSpring(0, SPRING);
  React.useEffect(() => {
    if (active != null) cursorX.set(xScale(active));
  }, [active, cursorX, xScale]);

  const onMove = useCallback((e) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !n) return;
    const rel = e.clientX - rect.left - MARGIN.left;
    setActive(Math.min(n - 1, Math.max(0, Math.round((rel / Math.max(1, innerW)) * (n - 1)))));
  }, [innerW, n]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Escape') { setActive(null); return; }
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    setActive((a) => Math.min(n - 1, Math.max(0, a == null ? 0 : a + step)));
  }, [n]);

  if (innerW <= 0) return null;

  const { solid, leadDashed, trailDashed } = trendSegments(data);

  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 76))));
  const hovering = active != null;
  const ax = (d) => xScale(d.i);
  const ay = (d) => yScale(d.value);

  return (
    <>
      <svg
        ref={svgRef}
        className="bk-chart-svg"
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onMouseMove={onMove}
        onMouseLeave={() => setActive(null)}
        onKeyDown={onKeyDown}
      >
        <defs>
          <EdgeFade id={`ln-${uid}`} color={cat(0)} />
          <FillFade id={`fl-${uid}`} color={cat(0)} />
        </defs>
        <rect className="bk-chart-surface" x={0} y={0} width={width} height={height} />
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
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

          {hovering && (
            <motion.line
              x1={cursorX}
              x2={cursorX}
              y1={0}
              y2={innerH}
              stroke="var(--chart-crosshair)"
              strokeWidth={1}
            />
          )}

          {/* The fill fades up from the baseline and is revealed by scaling
              from the baseline, so the area grows rather than sliding in. */}
          <g
            style={{
              transform: drawn ? 'scaleY(1)' : 'scaleY(0)',
              transformOrigin: `0px ${innerH}px`,
              transition: drawn ? `transform ${DRAW_MS}ms ${EASE}` : 'none',
            }}
          >
            {solid.length > 1 && (
              <AreaClosed
                data={solid}
                x={ax}
                y={ay}
                yScale={yScale}
                curve={curveNatural}
                fill={`url(#fl-${uid})`}
                stroke="none"
              />
            )}
          </g>

          {solid.length > 1 && (
            <LinePath
              data={solid}
              x={ax}
              y={ay}
              curve={curveNatural}
              stroke={`url(#ln-${uid})`}
              strokeWidth={2.5}
              strokeLinecap="round"
              fill="none"
              pathLength={1}
              strokeDasharray={1}
              style={{
                strokeDashoffset: drawn ? 0 : 1,
                transition: drawn ? `stroke-dashoffset ${DRAW_MS}ms ${EASE}` : 'none',
              }}
            />
          )}
          {leadDashed.length > 1 && (
            <LinePath
              data={leadDashed}
              x={ax}
              y={ay}
              curve={curveNatural}
              stroke={cat(0)}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray="5,5"
              fill="none"
              opacity={drawn ? 0.75 : 0}
              style={{ transition: `opacity ${DRAW_MS}ms ${EASE}` }}
            />
          )}
          {trailDashed.length > 1 && (
            <LinePath
              data={trailDashed}
              x={ax}
              y={ay}
              curve={curveNatural}
              stroke={cat(0)}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray="5,5"
              fill="none"
              opacity={drawn ? 0.75 : 0}
              style={{ transition: `opacity ${DRAW_MS}ms ${EASE}` }}
            />
          )}

          {hovering && data[active]?.value != null && (
            <motion.circle
              cx={cursorX}
              cy={yScale(data[active].value)}
              r={4.5}
              fill={cat(0)}
              stroke="var(--chart-background)"
              strokeWidth={2}
            />
          )}

          {data.map((d, i) =>
            i % every ? null : (
              <text
                key={`${d.label}-${i}`}
                className="bk-chart-tick"
                x={xScale(i)}
                y={innerH + 18}
                textAnchor="middle"
              >
                {d.label}
              </text>
            )
          )}
        </g>
      </svg>

      {hovering && data[active] && (
        <Tip
          x={xScale(active) + MARGIN.left}
          width={width}
          title={data[active].label}
          rows={[{
            name: data[active].forecast ? 'Forecast' : data[active].illustrative ? 'Illustrative' : 'Recorded',
            value: (data[active].value ?? 0).toLocaleString(),
            color: cat(0),
          }]}
        />
      )}
    </>
  );
}

export default function TrendArea({ data, height = 320, ariaLabel = 'Trend over time' }) {
  if (!data || !data.length) return <div className="rp-empty">No data</div>;
  return (
    <div className="bk-chart" style={{ height }}>
      {/* ParentSize reports height as well as width. Taking it lets a chart
          fill a bento tile that is taller than its default, while a caller
          that just passes `height` still gets exactly that — the wrapper's
          own height is what ParentSize ends up measuring. */}
      <ParentSize debounceTime={0}>
        {({ width, height: mh }) =>
          width < 10 ? null : (
            <Plot width={width} height={mh || height} data={data} ariaLabel={ariaLabel} />
          )
        }
      </ParentSize>
    </div>
  );
}

export { Plot };
