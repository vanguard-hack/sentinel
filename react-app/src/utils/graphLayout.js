/* Seeded force-directed layout for the canvas graph maps.
 *
 * Lifted out of crimelinks.js when the money-flow network needed the same
 * treatment. Two maps drawn by two different algorithms read as two different
 * products, and the crime-network map is the one officers already know how to
 * read — so the money map now runs through exactly this code.
 *
 * The layout runs ONCE, here, and the renderer only ever draws the result.
 * A live simulation in the browser is what made the old money-flow graph
 * expensive: it re-rendered the whole scene a few hundred times before
 * settling, and did it again on every interaction.
 *
 * Determinism is the other reason this is a module rather than an effect.
 * The seed is fixed, so the same data lays out identically every time — a map
 * that rearranged itself between two visits would be unreadable as a map.
 */

import { breathe } from './idle';

export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Repulsion + springs + a weak pull to the centre.
 *
 * Repulsion is O(n²), which is fine for the few hundred nodes these maps draw
 * and keeps the code readable. Nodes carry their own radius, and bigger nodes
 * push harder, so a large node claims the space its label needs.
 *
 * Mutates `nodes` in place: each gains x/y/vx/vy.
 */
export function layoutForce(nodes, links, rnd, iterations = 420) {
  const run = layoutSteps(nodes, links, rnd, iterations);
  let r = run.next();
  while (!r.done) r = run.next();
}

/**
 * The same layout, yielded in ~10ms slices.
 *
 * 420 iterations of an O(n²) repulsion over a few hundred nodes is a sixth of a
 * second in one unbroken block — enough that a click on the tab appeared to do
 * nothing at all until the map arrived. The arithmetic is identical; only the
 * scheduling differs, and the seed makes the result the same either way.
 */
export async function layoutForceAsync(nodes, links, rnd, iterations = 420, { sliceMs = 10 } = {}) {
  const run = layoutSteps(nodes, links, rnd, iterations);
  let r = run.next();
  let t0 = Date.now();
  while (!r.done) {
    if (Date.now() - t0 >= sliceMs) { await breathe(); t0 = Date.now(); }
    r = run.next();
  }
}

function* layoutSteps(nodes, links, rnd, iterations) {
  const n = nodes.length;
  if (!n) return;
  nodes.forEach((nd, i) => {
    const a = (i / n) * Math.PI * 2 + rnd() * 0.6;
    const r = 120 + rnd() * 260;
    nd.x = Math.cos(a) * r;
    nd.y = Math.sin(a) * r;
    nd.vx = 0;
    nd.vy = 0;
  });

  for (let it = 0; it < iterations; it++) {
    yield;
    const cool = 1 - it / iterations;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (rnd() - 0.5) * 0.5; dy = (rnd() - 0.5) * 0.5; d2 = 0.25; }
        const push = (3200 + (nodes[i].r + nodes[j].r) * 210) / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * push;
        const fy = (dy / d) * push;
        nodes[i].vx -= fx; nodes[i].vy -= fy;
        nodes[j].vx += fx; nodes[j].vy += fy;
      }
    }
    links.forEach((l) => {
      const a = nodes[l.s];
      const b = nodes[l.t];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const rest = 110 + a.r + b.r;
      const f = (d - rest) * 0.012;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    });
    nodes.forEach((nd) => {
      nd.vx += -nd.x * 0.0018;
      nd.vy += -nd.y * 0.0018;
      nd.vx *= 0.86; nd.vy *= 0.86;
      nd.x += nd.vx * cool;
      nd.y += nd.vy * cool;
    });
  }
}

/** Normalise a laid-out graph into a 0..1000 box so any dataset fits the same
 *  renderer, and scale the radii with it. */
export function normaliseLayout(nodes, span = 900, pad = 50) {
  if (!nodes.length) return;
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);
  const extent = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = span / extent;
  nodes.forEach((n) => {
    n.x = (n.x - minX) * scale + pad;
    n.y = (n.y - minY) * scale + pad;
    n.r *= Math.max(0.6, Math.min(1.6, scale));
  });
}

/** Connected components of an { s, t } edge list, as a count plus the set of
 *  node indices that touch at least one edge. */
export function components(nodes, links) {
  const parent = nodes.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  links.forEach((l) => { const a = find(l.s); const b = find(l.t); if (a !== b) parent[a] = b; });
  const linked = new Set();
  links.forEach((l) => { linked.add(l.s); linked.add(l.t); });
  return { clusters: new Set(nodes.map((_, i) => find(i))).size, linked };
}
