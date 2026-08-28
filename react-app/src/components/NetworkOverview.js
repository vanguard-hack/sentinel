import React, { useCallback, useEffect, useRef, useState } from 'react';
import ZoomControls from './ZoomControls';

// Whole-linkage-landscape view: every ring drawn at once.
//
// Rendered to a 2D canvas rather than SVG. The detail view's ~20 nodes are fine
// as DOM elements, but the overview draws every member of every ring — already
// well over a thousand, and several thousand if the case data grows — where one
// SVG element per node makes layout and hit-testing the bottleneck. A canvas
// redraws the same scene in a single pass.
const MIN_K = 0.3;
const MAX_K = 12;

export default function NetworkOverview({ overview, colorFor, onPick }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const [hover, setHover] = useState(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const panRef = useRef(null);
  const animRef = useRef(null);
  const sizeRef = useRef({ w: 900, h: 560 });

  const { nodes, links, rings } = overview;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const { w, h } = sizeRef.current;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { k, tx, ty } = viewRef.current;
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(k, k);

    const hoverRing = hover != null ? nodes[hover].ring : null;

    // Links first, faint — they read as cluster texture at this zoom.
    ctx.lineWidth = Math.max(0.4, 1.1 / k);
    links.forEach((l) => {
      const a = nodes[l.s];
      const b = nodes[l.t];
      ctx.strokeStyle = hoverRing == null
        ? 'rgba(51,65,90,0.62)'
        : (l.ring === hoverRing ? 'rgba(37,99,235,0.85)' : 'rgba(51,65,90,0.14)');
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });

    nodes.forEach((n, i) => {
      const r = (1.6 + Math.min(4.2, n.deg * 0.62)) / Math.max(0.6, Math.sqrt(k));
      const dim = hoverRing != null && n.ring !== hoverRing;
      ctx.globalAlpha = dim ? 0.22 : 1;
      ctx.fillStyle = colorFor(n.group);
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(0.8, r), 0, Math.PI * 2);
      ctx.fill();
      if (i === hover) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1.6 / k;
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;

    ctx.restore();
  }, [nodes, links, hover, colorFor]);

  // Keep the canvas matched to its container.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      sizeRef.current = { w: Math.max(200, cr.width), h: Math.max(200, cr.height) };
      draw();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => { draw(); }, [draw, view]);

  // Fit the whole network into the viewport.
  const fit = useCallback((animate = true) => {
    const { w, h } = sizeRef.current;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    if (!xs.length) return;
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    // Generous padding: the overview is meant to show the whole landscape, so
    // it should start further out than a tight bounding-box fit.
    const pad = 140;
    const k = Math.min(w / (maxX - minX + pad), h / (maxY - minY + pad), MAX_K) * 0.9;
    const target = {
      k,
      tx: w / 2 - ((minX + maxX) / 2) * k,
      ty: h / 2 - ((minY + maxY) / 2) * k,
    };
    if (!animate) { setView(target); return; }
    animateTo(target);
  }, [nodes]); // eslint-disable-line react-hooks/exhaustive-deps

  const animateTo = useCallback((to) => {
    const from = viewRef.current;
    if (animRef.current) cancelAnimationFrame(animRef.current);
    const t0 = performance.now();
    const DUR = 200;
    const ease = (t) => 1 - (1 - t) * (1 - t);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / DUR);
      const e = ease(t);
      setView({
        k: from.k + (to.k - from.k) * e,
        tx: from.tx + (to.tx - from.tx) * e,
        ty: from.ty + (to.ty - from.ty) * e,
      });
      if (t < 1) animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => { fit(false); }, [fit]);
  useEffect(() => () => { if (animRef.current) cancelAnimationFrame(animRef.current); }, []);

  const zoomBy = useCallback((factor) => {
    const { w, h } = sizeRef.current;
    const v = viewRef.current;
    const k = Math.max(MIN_K, Math.min(MAX_K, v.k * factor));
    const scale = k / v.k;
    animateTo({ k, tx: w / 2 - (w / 2 - v.tx) * scale, ty: h / 2 - (h / 2 - v.ty) * scale });
  }, [animateTo]);

  // Wheel zoom about the cursor (native listener — React's is passive).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setView((v) => {
        const k = Math.max(MIN_K, Math.min(MAX_K, v.k * Math.exp(-e.deltaY * 0.0018)));
        const scale = k / v.k;
        return { k, tx: px - (px - v.tx) * scale, ty: py - (py - v.ty) * scale };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const pick = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    const { k, tx, ty } = viewRef.current;
    const x = (e.clientX - r.left - tx) / k;
    const y = (e.clientY - r.top - ty) / k;
    let best = null;
    let bestD = 10 / k;
    nodes.forEach((n, i) => {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  const onDown = (e) => {
    const v = viewRef.current;
    panRef.current = { x0: e.clientX, y0: e.clientY, tx0: v.tx, ty0: v.ty, moved: false };
    const move = (ev) => {
      const p = panRef.current;
      if (!p) return;
      if (Math.abs(ev.clientX - p.x0) + Math.abs(ev.clientY - p.y0) > 3) p.moved = true;
      setView((vv) => ({ ...vv, tx: p.tx0 + (ev.clientX - p.x0), ty: p.ty0 + (ev.clientY - p.y0) }));
    };
    const up = (ev) => {
      const p = panRef.current;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      panRef.current = null;
      if (p && !p.moved) {
        const i = pick(ev);
        if (i != null && onPick) onPick(nodes[i].ring);
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onMove = (e) => {
    if (panRef.current) return;
    const i = pick(e);
    setHover((h) => (h === i ? h : i));
  };

  const hovered = hover != null ? nodes[hover] : null;

  return (
    <div className="net-graph net-overview" ref={wrapRef} tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.2); }
        else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / 1.2); }
        else if (e.key === '0') { e.preventDefault(); fit(); }
      }}
    >
      <ZoomControls
        onIn={() => zoomBy(1.2)}
        onOut={() => zoomBy(1 / 1.2)}
        onReset={() => fit()}
        label="network overview"
      />
      <canvas
        ref={canvasRef}
        className="net-canvas"
        style={{ width: '100%', height: '100%' }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onDoubleClick={() => fit()}
      />
      {hovered && (
        <div className="net-ov-tip">
          <strong>{hovered.label}</strong>
          <span>{hovered.group} · {hovered.deg} link{hovered.deg === 1 ? '' : 's'} · ring #{rings[hovered.ring]?.rank}</span>
          <span className="net-ov-tip-hint">Click to open this ring</span>
        </div>
      )}
    </div>
  );
}
