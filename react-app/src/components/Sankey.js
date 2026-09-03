import React, { useMemo, useState } from 'react';

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

const W = 1000;
const NW = 15;        // node bar width
const GAP = 7;        // vertical gap between nodes in a layer
const PAD_T = 14;
const PAD_B = 14;
const PAD_L = 170;    // room for category labels (left)
const PAD_R = 158;    // room for outcome labels (right)

/* Draw to the tile's REAL height instead of a fixed 460.
 *
 * The viewBox was a fixed 1000x460 scaled by width, so in a two-row bento tile
 * the diagram stopped a third of the way up the card and left the rest empty.
 * Stretching it with preserveAspectRatio="none" would have filled the tile and
 * squashed every label with it — text does not survive a non-uniform scale.
 * Measuring instead keeps the ribbons and the type undistorted and simply
 * gives the drawing the room the tile actually has. */
function useMeasuredHeight(initial) {
  const ref = React.useRef(null);
  const [h, setH] = React.useState(initial);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const ch = entries[0]?.contentRect?.height;
      // Below ~260 the labels collide; the tile scrolls rather than lying.
      if (ch) setH(Math.max(260, Math.round(ch)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, h];
}

export default function Sankey({ spec, height = 460 }) {
  const [wrapRef, drawH] = useMeasuredHeight(height);
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
  }, [spec, drawH]);

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
      <svg viewBox={`0 0 ${W} ${drawH}`} className="sk-svg" role="img" aria-label="Crime category to type to outcome flow">
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
