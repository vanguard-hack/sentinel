import React, { useCallback, useEffect, useRef, useState } from 'react';
import ZoomControls from './ZoomControls';
import { css } from '../utils/theme';

/* The graph map renderer.
 *
 * Extracted from NetworkOverview when the money-flow network needed the same
 * treatment. Two network maps in one product drawn two different ways is two
 * things to learn; this is the one officers already read, so the money map now
 * goes through exactly this renderer and differs only in what a node means.
 *
 * WHY CANVAS. One DOM element per node plus its label is the bottleneck past a
 * couple of hundred nodes, and the money map's predecessor was worse than that:
 * an SVG force simulation that re-rendered the whole React tree on each of 220
 * frames before it settled, then restarted from scratch whenever a node was
 * dragged. A canvas redraws the entire scene in one pass and the layout is
 * precomputed (utils/graphLayout), so opening the map costs one paint.
 *
 * POSITIONS ARE FIXED. Focus is a highlight, never a re-layout — a map that
 * rearranges under the officer who has learned it is not a map. The only
 * movement is a short settle-wobble on focus, and that is a render offset:
 * node coordinates are never written to.
 *
 * Props:
 *   nodes       [{ x, y, r, label, ...caller fields }] — already laid out
 *   links       [{ s, t }] — indices into nodes
 *   selected    index of the pinned node, or null
 *   onSelect    (index | null) => void
 *   colorOf     (node, { active, inFocus, hasFocus, text }) => css colour
 *   labelAlways (node) => draw its label at any zoom (default: large nodes)
 *   renderTip   (node) => JSX for the hover/selection card
 *   legend      [{ label, color }] — optional key drawn under the canvas
 */
const MIN_K = 0.25;
const MAX_K = 8;
const JIGGLE_MS = 620;

export default function GraphCanvas({
  nodes, links, selected, onSelect, colorOf,
  labelAlways = (n) => n.r > 20,
  renderTip, legend, ariaLabel = 'network map',
}) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const [hover, setHover] = useState(null);
  const focus = selected;
  const viewRef = useRef(view);
  viewRef.current = view;
  const panRef = useRef(null);
  const animRef = useRef(null);
  const sizeRef = useRef({ w: 900, h: 560 });
  const jiggleRef = useRef({ t0: 0, running: false });
  const jiggleRafRef = useRef(null);
  const drawRef = useRef(null);
  const fitRef = useRef(null);
  // A tab that is switched away from is hidden, not unmounted, so the observer
  // fires with a zero box. Re-fitting the moment it comes back is what stops
  // the map returning at the wrong scale, parked off the side of the canvas.
  const hadSizeRef = useRef(false);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // A 2D context can genuinely be absent — a headless renderer, a browser
    // with canvas disabled. Draw nothing rather than take the page down with it.
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
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

    // The active node — clicked if there is a selection, else hovered — plus
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

    nodes.forEach((n, i) => {
      const inFocus = near ? near.has(i) : true;
      const x = px(i);
      const y = py(i);
      ctx.globalAlpha = inFocus ? 1 : 0.16;
      ctx.fillStyle = colorOf(n, { active: i === active, inFocus, hasFocus: !!near });
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

    // Labels: the biggest nodes always, everything else once zoomed in — the
    // progressive disclosure the reference graph views use.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const fontPx = Math.max(8, Math.min(13, 11 / k));
    ctx.font = `${fontPx}px Inter, system-ui, sans-serif`;
    /* The halo is the CARD's surface, read from the stylesheet — it used to be
       a hardcoded white, which is a white outline around white-ish text on a
       dark canvas. It exists to hold the label off the edges and links behind
       it, so it has to be whatever the map is actually sitting on. */
    const halo = css('--bg-1');
    nodes.forEach((n, i) => {
      const inFocus = near ? near.has(i) : true;
      if (!labelAlways(n) && k < 1.5 && i !== active && i !== hover && !(near && inFocus)) return;
      // Out-of-focus labels recede, but not to the point of being ghosts: the
      // whole complaint about this map was that its text could not be read.
      ctx.globalAlpha = inFocus ? 1 : 0.35;
      ctx.lineWidth = 3 / k;
      ctx.strokeStyle = halo;
      const lx = px(i);
      const ly = py(i) + n.r + 4 / k;
      ctx.strokeText(n.label, lx, ly);
      ctx.fillStyle = colorOf(n, { active: i === active, inFocus, hasFocus: !!near, text: true });
      ctx.fillText(n.label, lx, ly);
    });
    ctx.globalAlpha = 1;
    ctx.restore();
  }, [nodes, links, hover, focus, colorOf, labelAlways]);

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

  drawRef.current = draw;
  fitRef.current = fit;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      if (!(cr.width > 0 && cr.height > 0)) { hadSizeRef.current = false; return; }
      sizeRef.current = { w: Math.max(200, cr.width), h: Math.max(200, cr.height) };
      const first = !hadSizeRef.current;
      hadSizeRef.current = true;
      if (first) fitRef.current?.(false); else drawRef.current?.();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { draw(); }, [draw, view]);

  // Focusing highlights and gives a short settle-wobble. It deliberately does
  // NOT move the camera: auto-zooming on click fought with wherever the officer
  // had panned to. Zoom stays under manual control (+/-/fit, scroll, drag).
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
      // Select rather than navigate — the map must not rearrange on a click.
      if (p && !p.moved && onSelect) onSelect(pick(ev));
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
        label={ariaLabel}
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
      {tip && renderTip && <div className="net-ov-tip">{renderTip(tip)}</div>}
      {legend && legend.length > 1 && (
        <div className="net-ov-legend">
          {legend.map((g) => (
            <span key={g.label}><i style={{ background: g.color }} /> {g.label}</span>
          ))}
        </div>
      )}
    </div>
  );
}
