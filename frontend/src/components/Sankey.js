import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { useReducedMotion } from 'motion/react';
import useMeasuredBox from './useMeasuredBox';

// Multi-column Sankey: ribbons between stages, a full end-to-end trace on
// hover/focus/tap, drifting particles, keyboard navigation, and an upright
// layout below 420px. No external chart library — same hand-rolled SVG
// approach the rest of this app's charts use, generalised from the old
// fixed-3-layer version (category → type → outcome is still the only real
// caller, via utils/reports.buildCrimeSankey, but nothing here assumes 3).
//
// `nodes`: { id, label, value?, column?, layer?, ci? }[] — column/layer are
// read interchangeably (layer is what buildCrimeSankey already emits); if
// neither is given, a node's column is inferred as its distance from a
// source (a node nothing flows into). Nodes keep the ORDER given — the
// caller decides what "the way people read them" means, this never re-sorts.
// `links`: { source, target, value, ci? }[]. A node's value, when not given,
// is the larger of what flows in and out.
//
// Every node in a column needs a distinct colour, and ribbons take their
// source node's colour, so this cycles the app's six shared categorical
// slots and varies opacity across columns instead of hue, rather than
// inventing colours the rest of the app has never heard of.
const PALETTE = ['var(--rp-cat-0)', 'var(--rp-cat-1)', 'var(--rp-cat-2)',
                 'var(--rp-cat-3)', 'var(--rp-cat-4)', 'var(--rp-cat-5)'];
const OTHER = 'var(--text-4)';
const colorSlot = (i, col) => (i + ((col * 2) % PALETTE.length)) % PALETTE.length;
const colorAlpha = (col) => Math.max(0.45, 1 - col * 0.26);

const NW = 15;         // node bar thickness
const GAP = 7;         // gap between nodes within a column
const PAD_T = 14;
const PAD_B = 14;
const HEADER_H = 20;   // reserved for column stage-name headers, normal layout only
const UPRIGHT_MAX_WIDTH = 420; // matches the spec's own breakpoint

const LABEL_FONT = "12px 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
// Average glyph width for 12px Inter (~0.52em) — only used when canvas 2D
// genuinely isn't available (jsdom in tests; conceivably a locked-down real
// browser). Real browsers measure the actual glyphs via canvas.
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
const LABEL_GAP = 8;
const LABEL_MARGIN = 6;
const clamp = (lo, v, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

// ── Column inference: a node's column defaults to its distance from a
// source (a node with no incoming links), per the documented contract. Only
// exercised when a caller supplies neither `column` nor `layer`. ──
function inferColumns(nodeIds, links) {
  const out = new Map(nodeIds.map((id) => [id, []]));
  const inDeg = new Map(nodeIds.map((id) => [id, 0]));
  links.forEach((l) => {
    if (!out.has(l.source) || !inDeg.has(l.target)) return;
    out.get(l.source).push(l.target);
    inDeg.set(l.target, inDeg.get(l.target) + 1);
  });
  const col = new Map(nodeIds.map((id) => [id, 0]));
  const queue = nodeIds.filter((id) => inDeg.get(id) === 0);
  const seen = new Set(queue);
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i];
    out.get(id).forEach((t) => {
      col.set(t, Math.max(col.get(t), col.get(id) + 1));
      if (!seen.has(t)) { seen.add(t); queue.push(t); }
    });
  }
  return col;
}

// ── Full-journey trace: hovering/focusing a node highlights every path that
// reaches it AND every path it reaches; hovering a ribbon highlights the
// paths that reach its source plus the paths its target reaches — the
// specific journey through that one ribbon, not every other thing its
// endpoints touch. ──
function buildGraphIndex(links) {
  const bySource = new Map();
  const byTarget = new Map();
  links.forEach((l, i) => {
    (bySource.get(l.source) || bySource.set(l.source, []).get(l.source)).push(i);
    (byTarget.get(l.target) || byTarget.set(l.target, []).get(l.target)).push(i);
  });
  return { bySource, byTarget };
}
function walk(startId, byDir, otherEnd, links) {
  const nodes = new Set([startId]);
  const linkIdx = new Set();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    (byDir.get(id) || []).forEach((li) => {
      linkIdx.add(li);
      const next = otherEnd(links[li]);
      if (!nodes.has(next)) { nodes.add(next); stack.push(next); }
    });
  }
  return { nodes, linkIdx };
}
function traceFor(id, links, index) {
  if (id == null) return null;
  if (typeof id === 'number') {
    // A specific ribbon: the chain into its source, the ribbon itself, the
    // chain out of its target.
    const l = links[id];
    const up = walk(l.source, index.byTarget, (x) => x.source, links);
    const down = walk(l.target, index.bySource, (x) => x.target, links);
    return {
      nodes: new Set([...up.nodes, ...down.nodes]),
      linkIdx: new Set([...up.linkIdx, id, ...down.linkIdx]),
    };
  }
  const up = walk(id, index.byTarget, (x) => x.source, links);
  const down = walk(id, index.bySource, (x) => x.target, links);
  return {
    nodes: new Set([...up.nodes, ...down.nodes]),
    linkIdx: new Set([...up.linkIdx, ...down.linkIdx]),
  };
}

const cubicAt = (t, p0, p1, p2, p3) => {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
};

export default function Sankey({
  nodes: nodesProp, links: linksProp, label, columns, unit = '', totalLabel = 'the total',
  formatValue, height = 340, particles, defaultParticles = true, onParticlesChange,
  particleToggle = true, emptyLabel = 'No flows yet', className,
}) {
  const [wrapRef, box] = useMeasuredBox(960, height);
  const reduceMotion = useReducedMotion();
  const fmt = useMemo(() => formatValue || ((v) => v.toLocaleString()), [formatValue]);

  const isControlled = particles !== undefined;
  const [internalOn, setInternalOn] = useState(defaultParticles);
  const particlesOn = (isControlled ? particles : internalOn) && !reduceMotion;
  const toggleParticles = () => {
    const next = !(isControlled ? particles : internalOn);
    if (!isControlled) setInternalOn(next);
    onParticlesChange?.(next);
  };

  const [traceKey, setTraceKey] = useState(null); // node id, or link index (number)
  const [focusIdx, setFocusIdx] = useState(null); // { col, i } — keyboard cursor
  const [announce, setAnnounce] = useState('');
  const svgRef = useRef(null);

  const links = useMemo(() => linksProp || [], [linksProp]);
  const nodes = useMemo(() => (nodesProp || []).filter((n) => n && n.id != null), [nodesProp]);

  const upright = box.w > 0 && box.w < UPRIGHT_MAX_WIDTH;
  const W = Math.max(upright ? 260 : 520, box.w);
  const drawH = Math.max(upright ? Math.max(480, height) : 260, box.h);

  const layout = useMemo(() => {
    if (!nodes.length || !links.length) return null;
    const ids = nodes.map((n) => n.id);
    const inferred = nodes.some((n) => n.column == null && n.layer == null) ? inferColumns(ids, links) : null;
    const colOf = (n) => n.column ?? n.layer ?? inferred.get(n.id) ?? 0;
    const numCols = Math.max(1, ...nodes.map(colOf)) + 1;

    const byCol = Array.from({ length: numCols }, () => []);
    nodes.forEach((n) => byCol[colOf(n)].push(n));

    // A node's value defaults to the larger of what flows in/out, per spec.
    const outSum = new Map();
    const inSum = new Map();
    links.forEach((l) => {
      outSum.set(l.source, (outSum.get(l.source) || 0) + l.value);
      inSum.set(l.target, (inSum.get(l.target) || 0) + l.value);
    });
    const valueOf = (n) => n.value ?? Math.max(outSum.get(n.id) || 0, inSum.get(n.id) || 0);

    const total = byCol[0].reduce((s, n) => s + valueOf(n), 0) || 1;
    const maxCount = Math.max(1, ...byCol.map((c) => c.length));
    const mainAxisSize = upright ? drawH : W;
    const crossAxisSize = upright ? W : drawH;

    // Label gutters, normal layout only: measured against the real labels in
    // the first/last columns rather than guessed as a share of width — a
    // gutter even a few px too narrow clips SVG text silently (it doesn't
    // wrap or ellipsize). Clamped: a floor so a short label set doesn't
    // starve the ribbons, a ceiling so one pathological label can't eat the
    // chart (the hidden table and hover value cover that case instead).
    let padStart = PAD_T;
    let padEnd = PAD_B;
    if (!upright) {
      const maxLeft = Math.max(0, ...byCol[0].map((n) => cachedTextWidth(n.label)));
      const maxRight = Math.max(0, ...byCol[numCols - 1].map((n) => cachedTextWidth(n.label)));
      padStart = clamp(92, NW + LABEL_GAP + maxLeft + LABEL_MARGIN, mainAxisSize * 0.4);
      padEnd = clamp(84, NW + LABEL_GAP + maxRight + LABEL_MARGIN, mainAxisSize * 0.4);
    }
    const headerPad = !upright && columns?.length ? HEADER_H : 0;
    const crossAvail = crossAxisSize - PAD_T - PAD_B - headerPad;
    const scale = (crossAvail - (maxCount - 1) * GAP) / total;

    const mainInner = mainAxisSize - padStart - padEnd - NW;
    const main0For = Array.from({ length: numCols }, (_, i) => (
      padStart + (numCols === 1 ? 0 : (mainInner * i) / (numCols - 1))
    ));

    const nodeMap = new Map();
    byCol.forEach((colNodes, col) => {
      const heights = colNodes.map((n) => Math.max(2, valueOf(n) * scale));
      const colH = heights.reduce((s, h) => s + h, 0) + (colNodes.length - 1) * GAP;
      let cross = PAD_T + headerPad + (crossAvail - colH) / 2;
      colNodes.forEach((n, i) => {
        const isOther = /^Other\b/i.test(n.label);
        const color = isOther ? OTHER : PALETTE[colorSlot(n.ci ?? i, col)];
        const alpha = isOther ? 1 : colorAlpha(col);
        nodeMap.set(n.id, {
          ...n, value: valueOf(n), color, alpha, col,
          main0: main0For[col], main1: main0For[col] + NW,
          cross0: cross, cross1: cross + heights[i],
        });
        cross += heights[i] + GAP;
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
      if (!node) return;
      idxs.sort((a, b) => (nodeMap.get(links[a].target)?.cross0 ?? 0) - (nodeMap.get(links[b].target)?.cross0 ?? 0));
      let off = node.cross0;
      idxs.forEach((i) => { const t = placed[i].value * scale; placed[i].sCross0 = off; placed[i].sCross1 = off + t; off += t; });
    });
    inBy.forEach((idxs, tid) => {
      const node = nodeMap.get(tid);
      if (!node) return;
      idxs.sort((a, b) => (nodeMap.get(links[a].source)?.cross0 ?? 0) - (nodeMap.get(links[b].source)?.cross0 ?? 0));
      let off = node.cross0;
      idxs.forEach((i) => { const t = placed[i].value * scale; placed[i].tCross0 = off; placed[i].tCross1 = off + t; off += t; });
    });

    return {
      nodeList: [...nodeMap.values()], nodeMap, links: placed, total, numCols, byCol,
      headerPad,
    };
  }, [nodes, links, upright, W, drawH, columns]);

  const graphIndex = useMemo(() => buildGraphIndex(links), [links]);
  const trace = useMemo(
    () => (traceKey != null ? traceFor(traceKey, links, graphIndex) : null),
    [traceKey, links, graphIndex],
  );

  // ── Keyboard navigation: Tab focuses the plot and the first node; arrows
  // move within/across columns (axes swap in the upright layout); Home/End
  // jump to the first/last column; Escape clears the highlight. ──
  const moveFocus = useCallback((col, i) => {
    if (!layout) return;
    const c = Math.max(0, Math.min(layout.numCols - 1, col));
    const list = layout.byCol[c];
    if (!list?.length) return;
    const idx = Math.max(0, Math.min(list.length - 1, i));
    const n = list[idx];
    setFocusIdx({ col: c, i: idx });
    setTraceKey(n.id);
    const full = layout.nodeMap.get(n.id);
    const share = ((full.value / layout.total) * 100).toFixed(1);
    const next = links.filter((l) => l.source === n.id).map((l) => layout.nodeMap.get(l.target)?.label).filter(Boolean);
    setAnnounce(
      `${n.label}: ${fmt(full.value)}${unit ? ` ${unit}` : ''}, ${share}% of ${totalLabel}`
      + (next.length ? `. Flows to ${next.join(', ')}.` : '.'),
    );
  }, [layout, links, fmt, unit, totalLabel]);

  const onKeyDown = (e) => {
    if (!layout) return;
    const alongMain = upright ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    const alongCross = upright ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const cur = focusIdx || { col: 0, i: 0 };
    if (e.key === 'Escape') { e.preventDefault(); setTraceKey(null); return; }
    if (e.key === 'Home') { e.preventDefault(); moveFocus(0, 0); return; }
    if (e.key === 'End') { e.preventDefault(); moveFocus(layout.numCols - 1, 0); return; }
    if (alongCross.includes(e.key)) {
      e.preventDefault();
      const dir = e.key === alongCross[1] ? 1 : -1;
      moveFocus(cur.col, cur.i + dir);
      return;
    }
    if (alongMain.includes(e.key)) {
      e.preventDefault();
      const dir = e.key === alongMain[1] ? 1 : -1;
      const targetCol = cur.col + dir;
      const curNode = layout.byCol[cur.col]?.[cur.i];
      const curFull = curNode && layout.nodeMap.get(curNode.id);
      const list = layout.byCol[targetCol];
      if (!curFull || !list?.length) { moveFocus(targetCol, 0); return; }
      // Nearest node by position, not just the same index.
      let bestI = 0, bestD = Infinity;
      list.forEach((n, i) => {
        const full = layout.nodeMap.get(n.id);
        const d = Math.abs((full.cross0 + full.cross1) / 2 - (curFull.cross0 + curFull.cross1) / 2);
        if (d < bestD) { bestD = d; bestI = i; }
      });
      moveFocus(targetCol, bestI);
    }
  };
  const onFocus = () => { if (!focusIdx && layout) moveFocus(0, 0); };
  const onBlur = () => { setFocusIdx(null); setTraceKey(null); };

  const pct = (v) => (layout ? `${((v / layout.total) * 100).toFixed(1)}%` : '0%');
  const dimmed = (key) => trace != null && !(typeof key === 'number' ? trace.linkIdx.has(key) : trace.nodes.has(key));

  const mainPoint = (main, cross) => (upright ? [cross, main] : [main, cross]);
  const ribbonPath = (l) => {
    const s = layout.nodeMap.get(l.source);
    const t = layout.nodeMap.get(l.target);
    if (!s || !t) return '';
    const sMain = s.main1, tMain = t.main0;
    const cMain = (sMain + tMain) / 2;
    const P = (main, cross) => mainPoint(main, cross).join(',');
    return `M${P(sMain, l.sCross0)} C${P(cMain, l.sCross0)} ${P(cMain, l.tCross0)} ${P(tMain, l.tCross0)}`
      + ` L${P(tMain, l.tCross1)} C${P(cMain, l.tCross1)} ${P(cMain, l.sCross1)} ${P(sMain, l.sCross1)} Z`;
  };

  // ── Particles: a canvas overlay, not SVG — cheaper to animate many dots,
  // and the spec's own performance note is to draw them on one canvas. Count
  // per ribbon scales with its share of the total so thick flows read as
  // busier without needing the full 34/ribbon ceiling the single-flow demo
  // in the docs uses (this chart typically shows many ribbons at once). ──
  const canvasRef = useRef(null);
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = wrapRef && svgRef.current?.closest?.('.sk-wrap');
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.01 });
    io.observe(el);
    return () => io.disconnect();
  }, [wrapRef]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout || !particlesOn || !inView) return undefined;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return undefined; // jsdom in tests has no 2D canvas context
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = drawH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const specs = layout.links.map((l, i) => {
      const s = layout.nodeMap.get(l.source);
      const t = layout.nodeMap.get(l.target);
      if (!s || !t) return null;
      const sMain = s.main1, tMain = t.main0, cMain = (sMain + tMain) / 2;
      const sCrossMid = (l.sCross0 + l.sCross1) / 2;
      const tCrossMid = (l.tCross0 + l.tCross1) / 2;
      const share = l.value / layout.total;
      const count = Math.max(1, Math.min(10, Math.round(2 + share * 40)));
      const particlesFor = Array.from({ length: count }, (_, p) => ({ offset: p / count }));
      return {
        i, color: s.color, dim: dimmed(i),
        p0: mainPoint(sMain, sCrossMid), p1: mainPoint(cMain, sCrossMid),
        p2: mainPoint(cMain, tCrossMid), p3: mainPoint(tMain, tCrossMid),
        particlesFor,
      };
    }).filter(Boolean);

    let raf;
    const SPEED = 0.00028; // loops/ms, tuned so a wide chart's ribbons read as a steady drift
    const draw = (now) => {
      ctx.clearRect(0, 0, W, drawH);
      specs.forEach((s) => {
        ctx.fillStyle = `color-mix(in srgb, ${s.color} 100%, transparent)`;
        ctx.globalAlpha = s.dim ? 0.08 : 0.85;
        s.particlesFor.forEach((p) => {
          const tt = (now * SPEED + p.offset) % 1;
          const x = cubicAt(tt, s.p0[0], s.p1[0], s.p2[0], s.p3[0]);
          const y = cubicAt(tt, s.p0[1], s.p1[1], s.p2[1], s.p3[1]);
          ctx.beginPath();
          ctx.arc(x, y, 1.6, 0, Math.PI * 2);
          ctx.fill();
        });
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, particlesOn, inView, W, drawH, traceKey]);

  if (!layout) return <div className="rp-empty">{emptyLabel}</div>;
  const { nodeList, links: placedLinks, numCols, headerPad } = layout;

  const showHeaders = !upright && columns?.length && W / numCols > 56;

  return (
    <div className={`sk-wrap${className ? ` ${className}` : ''}`}>
      <div className="sk-plot" ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${drawH}`}
        preserveAspectRatio="none"
        className="sk-svg"
        role="group"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        aria-activedescendant={focusIdx ? `sk-node-${layout.byCol[focusIdx.col]?.[focusIdx.i]?.id}` : undefined}
      >
        {showHeaders && layout.byCol.map((colNodes, col) => {
          if (!colNodes.length) return null;
          const n0 = layout.nodeMap.get(colNodes[0].id);
          const cx = (n0.main0 + n0.main1) / 2;
          return (
            <text key={`h${col}`} x={cx} y={PAD_T + headerPad - 8} textAnchor="middle" className="sk-header">
              {columns[col]}
            </text>
          );
        })}

        {placedLinks.map((l, i) => (
          <path
            key={i}
            d={ribbonPath(l)}
            className={`sk-link ${dimmed(i) ? 'sk-dim' : ''}`}
            style={{ fill: layout.nodeMap.get(l.source)?.color }}
            onMouseEnter={() => setTraceKey(i)}
            onMouseLeave={() => setTraceKey(null)}
            onClick={() => setTraceKey((cur) => (cur === i ? null : i))}
          >
            <title>
              {`${layout.nodeMap.get(l.source)?.label} → ${layout.nodeMap.get(l.target)?.label}: `
                + `${fmt(l.value)}${unit ? ` ${unit}` : ''} (${pct(l.value)})`}
            </title>
          </path>
        ))}

        {nodeList.map((n) => {
          const isFirst = n.col === 0;
          const isLast = n.col === numCols - 1;
          const rectAttrs = upright
            ? { x: n.cross0, y: n.main0, width: Math.max(2, n.cross1 - n.cross0), height: NW }
            : { x: n.main0, y: n.cross0, width: NW, height: Math.max(2, n.cross1 - n.cross0) };
          const labelPos = upright
            ? { x: (n.cross0 + n.cross1) / 2, y: n.main1 + 12, anchor: 'middle' }
            : isFirst
            ? { x: n.main0 - LABEL_GAP, y: (n.cross0 + n.cross1) / 2, anchor: 'end' }
            : { x: n.main1 + LABEL_GAP, y: (n.cross0 + n.cross1) / 2, anchor: 'start' };
          return (
            <g
              key={n.id}
              id={`sk-node-${n.id}`}
              className={focusIdx && layout.byCol[focusIdx.col]?.[focusIdx.i]?.id === n.id ? 'sk-focused' : ''}
              onMouseEnter={() => setTraceKey(n.id)}
              onMouseLeave={() => setTraceKey(null)}
              onClick={() => setTraceKey((cur) => (cur === n.id ? null : n.id))}
            >
              <rect
                {...rectAttrs}
                rx="2"
                className={`sk-node ${dimmed(n.id) ? 'sk-dim' : ''}`}
                style={{ fill: n.color, fillOpacity: n.alpha }}
              />
              <text
                x={labelPos.x}
                y={labelPos.y}
                textAnchor={labelPos.anchor}
                dominantBaseline={upright ? 'hanging' : 'middle'}
                className={`sk-label ${dimmed(n.id) ? 'sk-dim' : ''}`}
              >
                {n.label}
                {(isFirst || isLast || upright) && (
                  <tspan className="sk-label-val" dx="4">
                    {fmt(n.value)}{unit ? ` ${unit}` : ''}
                  </tspan>
                )}
              </text>
            </g>
          );
        })}
      </svg>

      {!reduceMotion && (
        <canvas ref={canvasRef} className="sk-particles" style={{ display: particlesOn ? 'block' : 'none' }} aria-hidden="true" />
      )}
      </div>

      {particleToggle && !reduceMotion && (
        <button type="button" className="sk-toggle" onClick={toggleParticles} aria-pressed={particlesOn}>
          {particlesOn ? 'Flow: on' : 'Flow: off'}
        </button>
      )}

      <div className="sr-only" aria-live="polite">{announce}</div>

      {/* The real data, for assistive tech — ribbons, particles, and labels
          are decorative past this point. */}
      <table className="sr-only">
        <caption>{label}</caption>
        <thead><tr><th>From</th><th>To</th><th>Value</th><th>Share of source</th></tr></thead>
        <tbody>
          {links.map((l, i) => {
            const s = layout.nodeMap.get(l.source);
            const sTotal = links.filter((x) => x.source === l.source).reduce((sum, x) => sum + x.value, 0) || 1;
            return (
              <tr key={i}>
                <td>{s?.label ?? l.source}</td>
                <td>{layout.nodeMap.get(l.target)?.label ?? l.target}</td>
                <td>{fmt(l.value)}{unit ? ` ${unit}` : ''}</td>
                <td>{`${((l.value / sTotal) * 100).toFixed(1)}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
