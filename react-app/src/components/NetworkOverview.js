import React, { useCallback, useEffect, useRef, useState } from 'react';
import ZoomControls from './ZoomControls';
import { css } from '../utils/theme';

// Ring-level map of the whole linkage landscape.
//
// One labelled node per ring, in the manner of Connected Papers / Obsidian's
// graph view: drawing every individual put a thousand anonymous dots on screen
// where nothing could be read. Node size is ring membership, colour is
// district, and an edge means two rings share a district or a crime type — a
// lead, not a claim that anyone co-offended across rings.
//
// Drawn to a 2D canvas rather than SVG: one DOM element per node plus its
// label is the bottleneck once there are hundreds, and a canvas redraws the
// whole scene in one pass.
const MIN_K = 0.25;
const MAX_K = 8;
const JIGGLE_MS = 620;

export default function NetworkOverview({ overview, selected, onSelect }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const [hover, setHover] = useState(null);
  // Focus is a highlight, never a re-layout: positions stay put so the map an
  // officer has learned never rearranges under them.
  const focus = selected;
  const viewRef = useRef(view);
  viewRef.current = view;
  const panRef = useRef(null);
  const animRef = useRef(null);
  const sizeRef = useRef({ w: 900, h: 560 });
  // A short settle-wobble when a ring is focused. It is a RENDER offset only —
  // node coordinates are never written to, so the map is in exactly the same
  // place once it dies down. Anything else would defeat stable positions.
  const jiggleRef = useRef({ t0: 0, running: false });
  const jiggleRafRef = useRef(null);
  const drawRef = useRef(null);

  const { nodes, links } = overview;

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

    // The active ring — clicked if there is a selection, else hovered — plus
    // everything it links to. Only that sub-network lights up; the rest of the
    // map stays visible but recedes.
    const active = hover != null ? hover : focus;
    let near = null;
    if (active != null) {
      near = new Set([active]);
      links.forEach((l) => {
        if (l.s === active) near.add(l.t);
        if (l.t === active) near.add(l.s);
      });
    }

    // Offsets decay to zero over JIGGLE_MS; each node gets its own phase so
    // the group shivers rather than sliding as one block.
    const jig = jiggleRef.current;
    const elapsed = jig.running ? performance.now() - jig.t0 : Infinity;
    const decay = elapsed < JIGGLE_MS ? (1 - elapsed / JIGGLE_MS) ** 2 : 0;
    const offset = (i) => {
      if (!decay || !near || !near.has(i)) return { dx: 0, dy: 0 };
      const amp = (i === active ? 2.6 : 4.2) * decay;
      const ph = i * 1.7;
      return {
        dx: Math.sin(elapsed / 42 + ph) * amp,
        dy: Math.cos(elapsed / 37 + ph * 1.3) * amp,
      };
    };
    const px = (i) => nodes[i].x + offset(i).dx;
    const py = (i) => nodes[i].y + offset(i).dy;

    ctx.lineCap = 'round';
    links.forEach((l) => {
      const a = { x: px(l.s), y: py(l.s) };
      const b = { x: px(l.t), y: py(l.t) };
      // Only edges of the focused ring itself are drawn hot, matching the
      // reference: its spokes stand out, the rest of the map falls away.
      const spoke = near && (l.s === active || l.t === active);
      ctx.lineWidth = Math.min(1.8, Math.max(0.45, (spoke ? 1.6 : 0.8) / k));
      ctx.strokeStyle = near
        ? (spoke ? 'rgba(99,102,241,0.85)' : 'rgba(140,152,175,0.13)')
        : 'rgba(140,152,175,0.42)';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });

    // One colour throughout — the only thing colour encodes here is focus.
    nodes.forEach((n, i) => {
      const inFocus = near ? near.has(i) : true;
      const x = px(i);
      const y = py(i);
      ctx.globalAlpha = inFocus ? 1 : 0.16;
      // Canvas cannot resolve CSS custom properties, so the accent is read
      // from the stylesheet once per paint rather than hardcoded here.
      ctx.fillStyle = i === active ? css('--primary') : (inFocus && near ? css('--primary-hover') : css('--text-4'));
      ctx.beginPath();
      ctx.arc(x, y, n.r, 0, Math.PI * 2);
      ctx.fill();
      if (i === active || i === hover) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(79,70,229,0.9)';
        ctx.lineWidth = 2 / k;
        ctx.beginPath();
        ctx.arc(x, y, n.r + 3.5 / k, 0, Math.PI * 2);
        ctx.stroke();
      }
    });

    // Labels: the largest rings always, everything else once zoomed in — the
    // same progressive disclosure the reference graph views use.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const fontPx = Math.max(8, Math.min(13, 11 / k));
    ctx.font = `${fontPx}px Inter, system-ui, sans-serif`;
    nodes.forEach((n, i) => {
      const inFocus = near ? near.has(i) : true;
      const big = n.r > 20;
      if (!big && k < 1.5 && i !== active && i !== hover && !(near && inFocus)) return;
      ctx.globalAlpha = inFocus ? 1 : 0.14;
      ctx.lineWidth = 3 / k;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      const lx = px(i);
      const ly = py(i) + n.r + 4 / k;
      ctx.strokeText(n.label, lx, ly);
      ctx.fillStyle = i === active ? css('--primary-strong') : css('--bg-4');
      ctx.fillText(n.label, lx, ly);
    });
    ctx.globalAlpha = 1;
    ctx.restore();
  }, [nodes, links, hover, focus]);

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
  drawRef.current = draw;

  const animateTo = useCallback((to) => {
    const from = viewRef.current;
    if (animRef.current) cancelAnimationFrame(animRef.current);
    const t0 = performance.now();
    const ease = (t) => 1 - (1 - t) * (1 - t);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / 200);
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

  const fit = useCallback((animate = true) => {
    const { w, h } = sizeRef.current;
    if (!nodes.length) return;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    // Tighter padding, so the map starts closer in and fills the canvas.
    // Node radii and their labels sit outside the coordinate bounds, so pad
    // generously — the default view should show the whole network centred,
    // with nothing clipped at the edges.
    const maxR = nodes.reduce((m, n) => Math.max(m, n.r), 0);
    const pad = 90 + maxR * 2;
    const k = Math.min(w / (maxX - minX + pad), h / (maxY - minY + pad), MAX_K);
    const to = { k, tx: w / 2 - ((minX + maxX) / 2) * k, ty: h / 2 - ((minY + maxY) / 2) * k };
    if (!animate) { setView(to); return; }
    animateTo(to);
  }, [nodes, animateTo]);

  // Focusing highlights and gives a short settle-wobble. It deliberately does
  // NOT move the camera: auto-zooming on click fought with wherever the
  // officer had panned to, and made comparing rings awkward. Zoom stays under
  // manual control (+/-/fit, scroll, drag).
  useEffect(() => {
    if (focus == null || !nodes[focus]) return undefined;
    jiggleRef.current = { t0: performance.now(), running: true };
    const tick = () => {
      const done = performance.now() - jiggleRef.current.t0 >= JIGGLE_MS;
      if (done) jiggleRef.current.running = false;
      drawRef.current?.();
      if (!done) jiggleRafRef.current = requestAnimationFrame(tick);
    };
    jiggleRafRef.current = requestAnimationFrame(tick);
    return () => { if (jiggleRafRef.current) cancelAnimationFrame(jiggleRafRef.current); };
  }, [focus, nodes]);

  useEffect(() => { fit(false); }, [fit]);
  useEffect(() => () => {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    if (jiggleRafRef.current) cancelAnimationFrame(jiggleRafRef.current);
  }, []);

  const zoomBy = useCallback((factor) => {
    const { w, h } = sizeRef.current;
    const v = viewRef.current;
    const k = Math.max(MIN_K, Math.min(MAX_K, v.k * factor));
    const scale = k / v.k;
    animateTo({ k, tx: w / 2 - (w / 2 - v.tx) * scale, ty: h / 2 - (h / 2 - v.ty) * scale });
  }, [animateTo]);

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
    let bestD = Infinity;
    nodes.forEach((n, i) => {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < n.r + 6 / k && d < bestD) { bestD = d; best = i; }
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
        // Select rather than navigate — the map must not rearrange on a click.
        if (onSelect) onSelect(i == null ? null : nodes[i].ring);
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

  const tip = hover != null ? nodes[hover] : (focus != null ? nodes[focus] : null);

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
      {tip && (
        <div className="net-ov-tip">
          <strong>{tip.label}</strong>
          <span>{tip.size} members · {tip.crimes} crimes</span>
          <span>{tip.group} · {tip.type}</span>
        </div>
      )}
    </div>
  );
}
