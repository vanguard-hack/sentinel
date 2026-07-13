import React, { useState, useMemo, useRef, useEffect } from 'react';

// Interactive crime-network graph for the assistant. A small force simulation
// (repulsion + spring + centring) lays out nodes; the user can drag nodes and
// click one to highlight it and its direct links. No external deps.
// Spec: { nodes:[{id,label,group?}], links:[{source,target}] }
const W = 560;
const H = 400;
const CAT = ['--rp-cat-0', '--rp-cat-1', '--rp-cat-2', '--rp-cat-3', '--rp-cat-4', '--rp-cat-5'];

export default function NetworkGraph({ spec }) {
  const rawNodes = useMemo(() => (Array.isArray(spec?.nodes) ? spec.nodes : []), [spec]);
  const rawLinks = useMemo(() => (Array.isArray(spec?.links) ? spec.links : []), [spec]);

  const [tick, setTick] = useState(0);
  const [sel, setSel] = useState(null);
  const [drag, setDrag] = useState(null);
  const svgRef = useRef(null);
  const sim = useRef({ nodes: [], links: [] });

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

  const toSvg = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * W,
      y: ((e.clientY - r.top) / r.height) * H,
    };
  };
  useEffect(() => {
    if (!drag) return undefined;
    const move = (e) => {
      const p = toSvg(e.touches ? e.touches[0] : e);
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

  if (!model.nodes.length) return <div className="rp-empty">No network data</div>;

  const neighbours = new Set();
  if (sel != null) {
    model.links.forEach((l) => {
      if (l.s === sel) neighbours.add(l.t);
      if (l.t === sel) neighbours.add(l.s);
    });
  }
  const dim = (i) => sel != null && i !== sel && !neighbours.has(i);
  void tick; // re-render trigger

  return (
    <div className="net-graph">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="net-svg" onClick={() => setSel(null)}>
        {model.links.map((l, i) => {
          const a = model.nodes[l.s];
          const b = model.nodes[l.t];
          const on = sel == null || l.s === sel || l.t === sel;
          return (
            <line
              key={i}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              className="net-link"
              style={{ opacity: on ? 0.5 : 0.08 }}
            />
          );
        })}
        {model.nodes.map((n, i) => {
          const r = 8 + Math.min(10, n.deg * 2);
          return (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              className={`net-node ${dim(i) ? 'dim' : ''} ${sel === i ? 'sel' : ''}`}
              onMouseDown={(e) => { e.stopPropagation(); setDrag({ i }); }}
              onClick={(e) => { e.stopPropagation(); setSel(sel === i ? null : i); }}
            >
              <circle r={r} style={{ fill: color(n.group) }} />
              <text y={r + 11} textAnchor="middle" className="net-label">{n.label}</text>
            </g>
          );
        })}
      </svg>
      <div className="net-meta">
        {sel != null ? (
          <span><strong>{model.nodes[sel].label}</strong> · {neighbours.size} connection{neighbours.size === 1 ? '' : 's'}</span>
        ) : (
          <span>{model.nodes.length} nodes · {model.links.length} links · drag to move, click to focus</span>
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
