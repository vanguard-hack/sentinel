/* ═══════════════════════════════════════════════════════════════════════════
   TrendLine — multi-series line chart

   Vendored from Bklit UI's line-chart (MIT, Copyright (c) 2026 uixmat,
   github.com/bklit/bklit-ui) and adapted. What was taken is the visual
   treatment and the visx rendering approach:

     · dashed horizontal grid, masked to fade out at both ends
     · curveCatmullRom lines at 2.5px with round caps, each stroked through a
       horizontal gradient so the series fades in and out at the edges
     · a left-to-right clip-path reveal on first paint
     · on hover the whole set drops to 30% and only the segment either side of
       the cursor is redrawn at full strength
     · a spring-tracked crosshair with a dot per series

   What was changed, and why:

     1. Upstream ships a demo hardcoded to two named series (uniqueUsers,
        pageviews) with its own generateData(). This takes the app's existing
        { name, points: [{ label, value }] } shape for N series, so it is a
        drop-in for the Charts.js MultiLine it replaces.
     2. Sentinel has no Tailwind, so the utility classes are gone and the
        styling lives in chart-tokens.css.
     3. Colours index the shared --rp-cat-* ramp rather than Bklit's two
        --chart-line-* variables, which is what keeps these charts on the same
        palette as every other chart in the app.
     4. points[].value may be null — a month outside the selected window. The
        upstream path builder has no concept of a gap, so lines are split into
        runs of consecutive non-null points and drawn per run.
     5. Motion is gated on prefers-reduced-motion, and the plot is reachable by
        keyboard (arrow keys move the cursor, Escape clears it).
   ═══════════════════════════════════════════════════════════════════════════ */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { curveCatmullRom } from '@visx/curve';
import { ParentSize } from '@visx/responsive';
import { scaleLinear } from '@visx/scale';
import { LinePath } from '@visx/shape';
import { motion, useReducedMotion, useSpring, useTransform } from 'motion/react';
import './chart-tokens.css';

const MARGIN = { top: 4, right: 12, bottom: 22, left: 36 };
const CATS = 6;
const DRAW_MS = 900;
const EASE = 'cubic-bezier(0.85, 0, 0.15, 1)';
const SPRING = { stiffness: 520, damping: 42, mass: 0.6 };
// Width of the "spotlight" that reveals the hovered neighbourhood at full
// brightness. A soft-edged band, not a hard cut, centred on the cursor.
const SPOTLIGHT_W = 90;

const fmtTick = (v) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000 ? `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`
      : String(Math.round(v));

/* Split a series into runs of consecutive points that actually have a value,
   so a gap in the middle of a year breaks the line instead of drawing a
   straight segment across months that were never in the window. */
function runsOf(points) {
  const runs = [];
  let cur = [];
  points.forEach((p, i) => {
    if (p.value == null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else {
      cur.push({ i, value: p.value });
    }
  });
  if (cur.length) runs.push(cur);
  return runs;
}

/* Exported for tests: ParentSize measures with a ResizeObserver, which jsdom
   does not implement, and the measurement wrapper is third-party code that a
   smoke test of our own drawing logic has no reason to exercise. */
export function Plot({ width, height, series, ariaLabel }) {
  const [active, setActive] = useState(null);
  const [drawn, setDrawn] = useState(false);
  const svgRef = useRef(null);
  const reduced = useReducedMotion();
  /* Every gradient and mask below is referenced by url(#id). Two charts on one
     page sharing an id means the second silently paints with the first one's
     definitions, so the ids are per-instance. */
  const uid = useId().replace(/:/g, '');

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const rows = useMemo(
    () => (series || []).filter((s) => s.points && s.points.length),
    [series]
  );
  const n = rows[0]?.points.length ?? 0;

  const maxV = useMemo(() => {
    const vals = rows.flatMap((s) => s.points.map((p) => p.value ?? 0));
    return Math.max(1, ...vals);
  }, [rows]);

  const xScale = useMemo(
    () => scaleLinear({ range: [0, innerW], domain: [0, Math.max(1, n - 1)] }),
    [innerW, n]
  );
  const yScale = useMemo(
    () => scaleLinear({
      range: [innerH, 0],
      // A small headroom so the highest point is not clipped by the stroke,
      // without `nice` rounding the max up a whole tick — that was empty
      // padding above the lines. Domain still starts at 0 so a count chart
      // does not exaggerate a flat series.
      domain: [0, maxV * 1.04],
    }),
    [innerH, maxV]
  );

  /* The reveal.
     Upstream animates the width of a rect inside a <clipPath>. That was ported
     first and rendered nothing at all: the referenced clip resolved to an
     empty region, and SVG drops any element whose clip-path cannot be
     resolved, so the chart drew its grid and its axes and no lines.

     This draws the lines on instead, animating stroke-dashoffset to zero.
     pathLength="1" normalises every path to unit length, so a single offset
     value works for all of them without measuring anything. It is the same
     technique upstream uses for its hover highlight, it needs no url(#id)
     reference, and it handles gapped runs for free. */
  useEffect(() => {
    if (drawn || innerW <= 0) return undefined;
    if (reduced) { setDrawn(true); return undefined; }
    const raf = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(raf);
  }, [drawn, innerW, reduced]);

  const cursorX = useSpring(0, SPRING);
  useEffect(() => {
    if (active != null) cursorX.set(xScale(active));
  }, [active, cursorX, xScale]);
  // The spotlight mask's rect is drawn left-edge-anchored, so it has to be
  // offset half its own width to stay centred on the cursor as it moves.
  const spotlightX = useTransform(cursorX, (v) => v - SPOTLIGHT_W / 2);

  const nearestIndex = useCallback(
    (clientX) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || n === 0) return null;
      const rel = clientX - rect.left - MARGIN.left;
      const i = Math.round((rel / Math.max(1, innerW)) * (n - 1));
      return Math.min(n - 1, Math.max(0, i));
    },
    [innerW, n]
  );

  const onMove = useCallback((e) => setActive(nearestIndex(e.clientX)), [nearestIndex]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Escape') { setActive(null); return; }
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    setActive((a) => Math.min(n - 1, Math.max(0, (a == null ? 0 : a + step))));
  }, [n]);

  if (!rows.length || innerW <= 0) return null;

  const labels = rows[0].points.map((p) => p.label);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 76))));
  const hovering = active != null;

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
          <linearGradient id={`bk-rowfade-${uid}`} x1="0%" x2="100%" y1="0%" y2="0%">
            <stop offset="0%" stopColor="#fff" stopOpacity="0" />
            <stop offset="10%" stopColor="#fff" stopOpacity="1" />
            <stop offset="90%" stopColor="#fff" stopOpacity="1" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id={`bk-rowmask-${uid}`}>
            <rect x="0" y="0" width={innerW} height={innerH} fill={`url(#bk-rowfade-${uid})`} />
          </mask>
          {rows.map((_, si) => (
            <linearGradient key={si} id={`bk-line-${uid}-${si}`} x1="0%" x2="100%" y1="0%" y2="0%">
              <stop offset="0%" stopColor={`var(--rp-cat-${si % CATS})`} stopOpacity="0" />
              <stop offset="12%" stopColor={`var(--rp-cat-${si % CATS})`} stopOpacity="1" />
              <stop offset="88%" stopColor={`var(--rp-cat-${si % CATS})`} stopOpacity="1" />
              <stop offset="100%" stopColor={`var(--rp-cat-${si % CATS})`} stopOpacity="0" />
            </linearGradient>
          ))}
          <pattern id={`bk-dots-${uid}`} width={14} height={14} patternUnits="userSpaceOnUse">
            <circle cx={1} cy={1} r={0.9} fill="var(--text-4)" />
          </pattern>
          {/* The hovered neighbourhood used to be a SEPARATE path, re-splined
              from just the 3 nearest points — which draws a visibly
              different (straighter) curve than the real line through the
              full series, a seam right where the highlight starts. A mask
              that reveals the SAME path at full brightness has no geometry
              to get wrong: it is the identical <LinePath>, just visible only
              in a soft band around the cursor instead of everywhere. */}
          <linearGradient id={`bk-spot-${uid}`} x1="0%" x2="100%" y1="0%" y2="0%">
            <stop offset="0%" stopColor="#fff" stopOpacity="0" />
            <stop offset="50%" stopColor="#fff" stopOpacity="1" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id={`bk-spot-mask-${uid}`}>
            <motion.rect x={spotlightX} y={0} width={SPOTLIGHT_W} height={innerH} fill={`url(#bk-spot-${uid})`} />
          </mask>
        </defs>

        <rect className="bk-chart-surface" x={0} y={0} width={width} height={height} />

        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* A texture floor for N overlapping series — three or more lines
              on a bare surface read as clutter with nothing under them; the
              dot grid gives the plot area a "there's a coordinate system
              here" floor the way the fading gridlines alone don't at a
              glance. Faint and masked the same way the grid is, so it
              dissolves at the plot's edges instead of ending in a hard box. */}
          <rect
            x={0}
            y={0}
            width={innerW}
            height={innerH}
            fill={`url(#bk-dots-${uid})`}
            opacity={0.4}
            mask={`url(#bk-rowmask-${uid})`}
          />
          <g mask={`url(#bk-rowmask-${uid})`}>
            {yScale.ticks(5).map((t) => (
              <line
                key={t}
                x1={0}
                x2={innerW}
                y1={yScale(t)}
                y2={yScale(t)}
                stroke="var(--chart-grid)"
                strokeDasharray="4,4"
              />
            ))}
          </g>
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

          <g>
            <motion.g
              animate={{ opacity: hovering ? 0.3 : 1 }}
              transition={{ duration: reduced ? 0 : 0.4, ease: 'easeInOut' }}
            >
              {rows.map((s, si) =>
                runsOf(s.points).map((run, ri) => (
                  <LinePath
                    key={`${s.name}-${ri}`}
                    data={run}
                    x={(d) => xScale(d.i)}
                    y={(d) => yScale(d.value)}
                    curve={curveCatmullRom}
                    stroke={`url(#bk-line-${uid}-${si})`}
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
                ))
              )}
            </motion.g>
          </g>

          {/* The hovered neighbourhood, at full brightness — the exact same
              paths as the dimmed set above (same data, same curve call), so
              there is nothing for this layer to draw differently. The mask
              is the only thing doing work: it just decides how much of the
              identical curve is visible. */}
          {hovering && (
            <g mask={`url(#bk-spot-mask-${uid})`}>
              {rows.map((s, si) =>
                runsOf(s.points).map((run, ri) => (
                  <LinePath
                    key={`hl-${s.name}-${ri}`}
                    data={run}
                    x={(d) => xScale(d.i)}
                    y={(d) => yScale(d.value)}
                    curve={curveCatmullRom}
                    stroke={`var(--rp-cat-${si % CATS})`}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    fill="none"
                  />
                ))
              )}
            </g>
          )}

          {hovering &&
            rows.map((s, si) => {
              const v = s.points[active]?.value;
              if (v == null) return null;
              return (
                <motion.circle
                  key={`dot-${s.name}`}
                  cx={cursorX}
                  cy={yScale(v)}
                  r={4.5}
                  fill={`var(--rp-cat-${si % CATS})`}
                  stroke="var(--chart-background)"
                  strokeWidth={2}
                  // cx already glides via the spring MotionValue above; cy
                  // was a plain attribute that snapped to the next point
                  // instantly, so the dot looked like it was sliding
                  // sideways and teleporting vertically — the same
                  // asymmetric-smoothness bug TrendArea's single dot had.
                  // A CSS transition on the attribute closes the other half.
                  style={{ transition: reduced ? 'none' : 'cy 0.22s cubic-bezier(0.4,0,0.2,1)' }}
                />
              );
            })}

          {labels.map((l, i) =>
            i % every ? null : (
              <text
                key={`${l}-${i}`}
                className="bk-chart-tick"
                x={xScale(i)}
                y={innerH + 18}
                textAnchor="middle"
              >
                {l}
              </text>
            )
          )}
        </g>
      </svg>

      {hovering && (
        <div
          className="lc-tip"
          style={
            xScale(active) + MARGIN.left < width / 2
              ? { left: xScale(active) + MARGIN.left + 14 }
              : { left: xScale(active) + MARGIN.left - 14, transform: 'translateX(-100%)' }
          }
        >
          <div className="lc-tip-title">{labels[active]}</div>
          {rows.map((s, si) =>
            s.points[active]?.value == null ? null : (
              <div className="lc-tip-row" key={s.name}>
                <span className="lc-tip-dot" style={{ background: `var(--rp-cat-${si % CATS})` }} />
                {s.name}
                <b>{s.points[active].value.toLocaleString()}</b>
              </div>
            )
          )}
        </div>
      )}
    </>
  );
}

// No range bar: it took a strip of the card and, on long ranges, left the plot
// above it blank. The page's own date-range picker already narrows the window.
export default function TrendLine({ series, height = 340, ariaLabel = 'Trend over time' }) {
  const rows = (series || []).filter((s) => s.points && s.points.length);
  if (!rows.length) return <div className="rp-empty">No data</div>;

  return (
    <div className="bk-chart-wrap">
      <div className="bk-chart" style={{ height }}>
        {/* ParentSize reports height as well as width. Taking it lets a chart
            fill a bento tile that is taller than its default, while a caller
            that just passes `height` still gets exactly that — the wrapper's
            own height is what ParentSize ends up measuring. */}
        <ParentSize debounceTime={0}>
          {({ width, height: mh }) =>
            width < 10 ? null : (
              <Plot width={width} height={mh || height} series={rows} ariaLabel={ariaLabel} />
            )
          }
        </ParentSize>
      </div>
    </div>
  );
}
