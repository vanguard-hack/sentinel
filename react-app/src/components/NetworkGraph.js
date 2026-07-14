import React, { useState, useMemo, useRef, useEffect } from 'react';

// Interactive crime-network graph (Obsidian-graph-view style). A small force
// simulation (repulsion + spring + centring) lays out nodes; hovering a node
// fades everything but it and its direct neighbours, clicking pins that
// focus, the wheel zooms about the cursor and dragging the background pans.
// No external deps. Spec: { nodes:[{id,label,group?}], links:[{source,target}] }
const W = 560;
const H = 400;
const CAT = ['--rp-cat-0', '--rp-cat-1', '--rp-cat-2', '--rp-cat-3', '--rp-cat-4', '--rp-cat-5'];
const MIN_K = 0.4;
const MAX_K = 6;

// A zoom level `k` centred on the canvas midpoint.
const viewAt = (k) => ({ k, tx: (W / 2) * (1 - k), ty: (H / 2) * (1 - k) });

export default function NetworkGraph({ spec, initialZoom = 1 }) {
  const rawNodes = useMemo(() => (Array.isArray(spec?.nodes) ? spec.nodes : []), [spec]);
  const rawLinks = useMemo(() => (Array.isArray(spec?.links) ? spec.links : []), [spec]);

  const [tick, setTick] = useState(0);
  const [sel, setSel] = useState(null);
  const [hover, setHover] = useState(null);
  const [drag, setDrag] = useState(null); // { i } node drag
  const [view, setView] = useState(() => viewAt(initialZoom));
  const svgRef = useRef(null);
  const sim = useRef({ nodes: [], links: [] });
  const viewRef = useRef(view);
  viewRef.current = view;
  const panRef = useRef(null); // { x0, y0, tx0, ty0, moved }

  // Build the simulation model once per spec.
  const model = useMemo(() => {
    const ids = new Map();
    const nodes = rawNodes
      .filter((n) => n && n.id != null)
      .map((n, i) => {
        ids.set(String(n.id), i);
        return {
          id: String(n.id),
          label: n.label || String(n.id),
          group: n.group || 'default',
          x: W / 2 + Math.cos((i / rawNodes.length) * 2 * Math.PI) * 120,
          y: H / 2 + Math.sin((i / rawNodes.length) * 2 * Math.PI) * 120,
          vx: 0, vy: 0, deg: 0,
        };
      });
    const links = rawLinks
      .map((l) => ({ s: ids.get(String(l.source)), t: ids.get(String(l.target)) }))
      .filter((l) => l.s != null && l.t != null && l.s !== l.t);
    links.forEach((l) => { nodes[l.s].deg++; nodes[l.t].deg++; });
    const groups = [...new Set(nodes.map((n) => n.group))];
    return { nodes, links, groups };
  }, [rawNodes, rawLinks]);

  sim.current = model;

  // Run the force simulation for a fixed number of frames, then stop (static).
  useEffect(() => {
    let frame = 0;
    let raf;
    const step = () => {
      const { nodes, links } = sim.current;
      if (!nodes.length) return;
      // repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let dx = nodes[i].x - nodes[j].x;
          let dy = nodes[i].y - nodes[j].y;
          let d2 = dx * dx + dy * dy || 0.01;
          const f = 2400 / d2;
          const d = Math.sqrt(d2);
          const ux = dx / d;
          const uy = dy / d;
          nodes[i].vx += ux * f; nodes[i].vy += uy * f;
          nodes[j].vx -= ux * f; nodes[j].vy -= uy * f;
        }
      }
      // springs
      links.forEach((l) => {
        const a = nodes[l.s];
        const b = nodes[l.t];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - 90) * 0.02;
        const ux = dx / d;
        const uy = dy / d;
        a.vx += ux * f; a.vy += uy * f;
        b.vx -= ux * f; b.vy -= uy * f;
      });
      // centring + integrate
      nodes.forEach((n, i) => {
        if (drag && drag.i === i) return;
        n.vx += (W / 2 - n.x) * 0.006;
        n.vy += (H / 2 - n.y) * 0.006;
        n.vx *= 0.82; n.vy *= 0.82;
        n.x = Math.max(16, Math.min(W - 16, n.x + n.vx));
        n.y = Math.max(16, Math.min(H - 16, n.y + n.vy));
      });
      setTick((t) => t + 1);
      frame++;
      if (frame < 220) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [model, drag]);

  const color = (g) => `var(${CAT[model.groups.indexOf(g) % CAT.length]})`;

  // Screen event → svg-space (0..W/H) and world-space (pre-transform) points.
  const toSvg = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * W,
      y: ((e.clientY - r.top) / r.height) * H,
    };
  };
  const toWorld = (p) => {
    const { k, tx, ty } = viewRef.current;
    return { x: (p.x - tx) / k, y: (p.y - ty) / k };
  };

  // Wheel zoom about the cursor. Native listener — React's is passive.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const p = toSvg(e);
      setView((v) => {
        const k = Math.max(MIN_K, Math.min(MAX_K, v.k * Math.exp(-e.deltaY * 0.0018)));
        const scale = k / v.k;
        return { k, tx: p.x - (p.x - v.tx) * scale, ty: p.y - (p.y - v.ty) * scale };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Node dragging (accounts for the zoom/pan transform).
  useEffect(() => {
    if (!drag) return undefined;
    const move = (e) => {
      const p = toWorld(toSvg(e.touches ? e.touches[0] : e));
      const n = sim.current.nodes[drag.i];
      if (n) { n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0; setTick((t) => t + 1); }
    };
    const up = () => setDrag(null);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('touchmove', move);
    window.addEventListener('touchend', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
    };
  }, [drag]);

  // Background panning; a press that never moves counts as a click-to-clear.
  const panStart = (e) => {
    const p = toSvg(e.touches ? e.touches[0] : e);
    panRef.current = { x0: p.x, y0: p.y, tx0: viewRef.current.tx, ty0: viewRef.current.ty, moved: false };
  };
  useEffect(() => {
    const move = (e) => {
      const pan = panRef.current;
      if (!pan) return;
      const p = toSvg(e.touches ? e.touches[0] : e);
      const dx = p.x - pan.x0;
      const dy = p.y - pan.y0;
      if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
      if (pan.moved) setView((v) => ({ ...v, tx: pan.tx0 + dx, ty: pan.ty0 + dy }));
    };
    const up = () => {
      const pan = panRef.current;
      if (pan && !pan.moved) setSel(null);
      panRef.current = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('touchmove', move);
    window.addEventListener('touchend', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
    };
  }, []);

  if (!model.nodes.length) return <div className="rp-empty">No network data</div>;

  // Focus = pinned selection, else hover. Everything else fades (Obsidian-style).
  const focus = sel != null ? sel : hover;
  const neighbours = new Set();
  if (focus != null) {
    model.links.forEach((l) => {
      if (l.s === focus) neighbours.add(l.t);
      if (l.t === focus) neighbours.add(l.s);
    });
  }
  const dim = (i) => focus != null && i !== focus && !neighbours.has(i);
  void tick; // re-render trigger

  // Labels stay hidden until they matter: zoomed in, a hub, or in focus.
  const labelOn = (n, i) =>
    focus === i || neighbours.has(i) || view.k >= 1.6 || n.deg >= 4;

  const { k, tx, ty } = view;

  return (
    <div className="net-graph">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={`net-svg ${focus != null ? 'focused' : ''}`}
        onMouseDown={panStart}
        onTouchStart={panStart}
        onDoubleClick={() => setView(viewAt(initialZoom))}
      >
        <g transform={`translate(${tx},${ty}) scale(${k})`}>
          {model.links.map((l, i) => {
            const a = model.nodes[l.s];
            const b = model.nodes[l.t];
            const on = focus == null || l.s === focus || l.t === focus;
            return (
              <line
                key={i}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                className={`net-link ${on ? '' : 'dim'}`}
                strokeWidth={1.2 / k}
              />
            );
          })}
          {model.nodes.map((n, i) => {
            const r = 5 + Math.min(11, n.deg * 1.8);
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                className={`net-node ${dim(i) ? 'dim' : ''} ${sel === i ? 'sel' : ''} ${focus === i ? 'focus' : ''}`}
                onMouseDown={(e) => { e.stopPropagation(); setDrag({ i }); }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                onClick={(e) => { e.stopPropagation(); setSel(sel === i ? null : i); }}
              >
                {focus === i && <circle r={r + 5} className="net-halo" />}
                <circle r={r} style={{ fill: color(n.group) }} />
                <text
                  y={r + 11}
                  textAnchor="middle"
                  className={`net-label ${labelOn(n, i) ? 'on' : ''}`}
                  style={{ fontSize: Math.max(5.5, 10 / Math.sqrt(k)) }}
                >
                  {n.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="net-meta">
        {focus != null ? (
          <span><strong>{model.nodes[focus].label}</strong> · {neighbours.size} connection{neighbours.size === 1 ? '' : 's'}</span>
        ) : (
          <span>{model.nodes.length} nodes · {model.links.length} links · hover to trace, scroll to zoom, drag space to pan</span>
        )}
        {model.groups.length > 1 && (
          <div className="net-legend">
            {model.groups.map((g) => (
              <span key={g}><i style={{ background: color(g) }} /> {g}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
