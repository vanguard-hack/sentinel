import React, { useMemo, useState } from 'react';
import useMeasuredBox from './useMeasuredBox';

// Self-contained 3-layer Sankey (no external lib). Consumes { nodes, links }
// from utils/reports.buildCrimeSankey: nodes carry { id, label, layer, value,
// ci } and links carry { source, target, value, ci }. `ci` is a category
// colour index (-1 = neutral). Ribbon thickness and node height share one
// scale, so a node's height equals the sum of its ribbons.
// Every node in a layer needs a distinct colour, and ribbons take their source
// node's colour, so a Sankey wants more slots than a bar chart does.
//
// This used to be eighteen literal hex values — eighteen chromatic accents in
// a system that has one. It now cycles the six shared categorical slots and
// varies opacity across the three passes instead of hue, so the chart stays
// legible without inventing colours the rest of the app has never heard of.
const PALETTE = ['var(--rp-cat-0)', 'var(--rp-cat-1)', 'var(--rp-cat-2)',
                 'var(--rp-cat-3)', 'var(--rp-cat-4)', 'var(--rp-cat-5)'];
const OTHER = 'var(--text-4)';
// Offset each layer into the palette so a category and a type in adjacent
// columns are unlikely to land on the same hue. Co-prime with 6 so the two
// offsets never collapse onto each other.
const LAYER_OFFSET = [0, 2, 4];
// Layers also separate by weight — solid, then two lighter passes — so a
// three-column chart stays readable on six hues instead of eighteen.
const LAYER_ALPHA = [1, 0.74, 0.5];

const NW = 15;        // node bar width
const GAP = 7;        // vertical gap between nodes in a layer
const PAD_T = 14;
const PAD_B = 14;

/* Label gutters used to be a SHARE of the drawing width with a fixed floor —
 * which is exactly why long labels ("Crimes Against Body", "Under
 * investigation") got clipped by the SVG's own viewport edge: the floor was
 * tuned against whatever labels existed at the time, not measured against
 * the ones actually being drawn. SVG text does not wrap or ellipsize on
 * overflow, so a gutter even a few px too narrow clips silently.
 *
 * Gutters are now sized from the real rendered width of the longest label in
 * each outer layer, via a cached canvas measurement — the same technique a
 * browser uses internally, just done once up front instead of guessed. */
const clamp = (lo, v, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

const LABEL_FONT = "12px 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
// Average glyph width for 12px Inter (~0.52em, typical for a sans-serif at
// this weight) — this only runs when canvas 2D genuinely isn't available
// (jsdom in tests; conceivably a locked-down real browser). Real browsers
// measure the actual glyphs via canvas; this is only ever an approximation
// for the fallback path.
const FALLBACK_CHAR_WIDTH = 6.3;
let measureCtx;
function textWidth(s) {
  const str = String(s || '');
  if (measureCtx === undefined) {
    const c = document.createElement('canvas');
    measureCtx = c.getContext && c.getContext('2d');
    if (measureCtx) measureCtx.font = LABEL_FONT;
  }
  return measureCtx ? measureCtx.measureText(str).width : str.length * FALLBACK_CHAR_WIDTH;
}
// Cached per unique label string — the same crime-head/outcome names repeat
// across every render of every report, so this fills once and stays warm.
const widthCache = new Map();
function cachedTextWidth(s) {
  if (widthCache.has(s)) return widthCache.get(s);
  const w = textWidth(s);
  widthCache.set(s, w);
  return w;
}
const LABEL_GAP = 8;   // space between the node bar and its label, each side
const LABEL_MARGIN = 6; // breathing room past the widest label

export default function Sankey({ spec, width = 1000, height = 460 }) {
  const [wrapRef, box] = useMeasuredBox(width, height);
  // Below these the labels collide with each other and with the ribbons; the
  // wrapper scrolls rather than drawing something that cannot be read.
  const W = Math.max(520, box.w);
  const drawH = Math.max(260, box.h);
  // Measured against the actual labels being drawn, not guessed as a share
  // of width — the bug this replaces. Still clamped: a floor so a short
  // label set doesn't starve the ribbons of space, a ceiling so one
  // pathological label can't eat half the chart (title tooltip covers that
  // case instead).
  const leftNodes = (spec?.nodes || []).filter((n) => n.layer === 0);
  const rightNodes = (spec?.nodes || []).filter((n) => n.layer === 2);
  const maxLeftLabel = Math.max(0, ...leftNodes.map((n) => cachedTextWidth(n.label)));
  const maxRightLabel = Math.max(0, ...rightNodes.map((n) => cachedTextWidth(n.label)));
  const PAD_L = clamp(92, NW + LABEL_GAP + maxLeftLabel + LABEL_MARGIN, W * 0.4);
  const PAD_R = clamp(84, NW + LABEL_GAP + maxRightLabel + LABEL_MARGIN, W * 0.4);
  const [hover, setHover] = useState(null); // node id or link idx
  const layout = useMemo(() => {
    const nodes = spec?.nodes || [];
    const links = spec?.links || [];
    if (!nodes.length || !links.length) return null;

    const layers = [0, 1, 2].map((L) =>
      nodes.filter((n) => n.layer === L).sort((a, b) => b.value - a.value)
    );
    const total = layers[0].reduce((s, n) => s + n.value, 0) || 1;
    const maxCount = Math.max(1, ...layers.map((l) => l.length));
    const availH = drawH - PAD_T - PAD_B;
    const scale = (availH - (maxCount - 1) * GAP) / total;

    const midX0 = PAD_L + (W - PAD_L - PAD_R - NW) / 2;
    const x0For = [PAD_L, midX0, W - PAD_R - NW];

    const nodeMap = new Map();
    layers.forEach((layer, L) => {
      const heights = layer.map((n) => Math.max(2, n.value * scale));
      const layerH = heights.reduce((s, h) => s + h, 0) + (layer.length - 1) * GAP;
      let y = PAD_T + (availH - layerH) / 2;
      layer.forEach((n, i) => {
        const slot = (i + LAYER_OFFSET[L]) % PALETTE.length;
        const isOther = /^Other\b/i.test(n.label);
        const color = isOther ? OTHER : PALETTE[slot];
        const alpha = isOther ? 1 : LAYER_ALPHA[L];
        nodeMap.set(n.id, { ...n, color, alpha, x0: x0For[L], x1: x0For[L] + NW, y0: y, y1: y + heights[i], oOut: 0, oIn: 0 });
        y += heights[i] + GAP;
      });
    });

    // Stack ribbons within each node, ordered by the opposite end's position
    // so they don't cross needlessly.
    const outBy = new Map();
    const inBy = new Map();
    links.forEach((l, i) => {
      (outBy.get(l.source) || outBy.set(l.source, []).get(l.source)).push(i);
      (inBy.get(l.target) || inBy.set(l.target, []).get(l.target)).push(i);
    });
    const placed = links.map((l) => ({ ...l }));
    outBy.forEach((idxs, sid) => {
      const node = nodeMap.get(sid);
      idxs.sort((a, b) => nodeMap.get(links[a].target).y0 - nodeMap.get(links[b].target).y0);
      let off = node.y0;
      idxs.forEach((i) => { const t = placed[i].value * scale; placed[i].sy0 = off; placed[i].sy1 = off + t; off += t; });
    });
    inBy.forEach((idxs, tid) => {
      const node = nodeMap.get(tid);
      idxs.sort((a, b) => nodeMap.get(links[a].source).y0 - nodeMap.get(links[b].source).y0);
      let off = node.y0;
      idxs.forEach((i) => { const t = placed[i].value * scale; placed[i].ty0 = off; placed[i].ty1 = off + t; off += t; });
    });

    return { nodeList: [...nodeMap.values()], nodeMap, links: placed, total };
  }, [spec, W, drawH, PAD_L, PAD_R]);

  if (!layout) return <div className="rp-empty">No data</div>;
  const { nodeList, nodeMap, links, total } = layout;

  const ribbon = (l) => {
    const s = nodeMap.get(l.source);
    const t = nodeMap.get(l.target);
    const sx = s.x1;
    const tx = t.x0;
    const cx = (sx + tx) / 2;
    return `M${sx},${l.sy0} C${cx},${l.sy0} ${cx},${l.ty0} ${tx},${l.ty0}`
      + ` L${tx},${l.ty1} C${cx},${l.ty1} ${cx},${l.sy1} ${sx},${l.sy1} Z`;
  };

  const pct = (v) => `${((v / total) * 100).toFixed(1)}%`;

  return (
    <div className="sk-wrap" ref={wrapRef}>
      <svg viewBox={`0 0 ${W} ${drawH}`} preserveAspectRatio="none" className="sk-svg" role="img" aria-label="Crime category to type to outcome flow">
        {/* ribbons */}
        {links.map((l, i) => {
          const dim = hover != null && hover !== l.source && hover !== l.target && hover !== `l${i}`;
          return (
            <path
              key={i}
              d={ribbon(l)}
              className={`sk-link ${dim ? 'sk-dim' : ''}`}
              style={{ fill: nodeMap.get(l.source).color }}
              onMouseEnter={() => setHover(`l${i}`)}
              onMouseLeave={() => setHover(null)}
            >
              <title>{`${nodeMap.get(l.source).label} → ${nodeMap.get(l.target).label}: ${l.value.toLocaleString()} (${pct(l.value)})`}</title>
            </path>
          );
        })}
        {/* nodes + labels */}
        {nodeList.map((n) => {
          const fill = n.color;
          const fillOpacity = n.alpha;
          const labelLeft = n.layer === 0;
          return (
            <g
              key={n.id}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
            >
              <rect x={n.x0} y={n.y0} width={NW} height={Math.max(2, n.y1 - n.y0)} rx="2" className="sk-node" style={{ fill, fillOpacity }}>
                <title>{`${n.label}: ${n.value.toLocaleString()} (${pct(n.value)})`}</title>
              </rect>
              <text
                x={labelLeft ? n.x0 - 8 : n.x1 + 8}
                y={(n.y0 + n.y1) / 2}
                textAnchor={labelLeft ? 'end' : 'start'}
                dominantBaseline="middle"
                className="sk-label"
              >
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
