/* The money-flow map.
 *
 * It used to ship a bare node-and-edge list to an SVG force simulation that ran
 * in the browser: 220 frames, each re-rendering the whole React tree, restarted
 * from scratch every time a node was touched — and it drew one line per
 * TRANSFER, so a dozen payments between the same two accounts were a dozen
 * lines stacked on each other. It now goes through the same precomputed layout
 * and the same canvas renderer as the crime-network map.
 *
 * These pin the three things that makes true: one edge per relationship, a
 * layout that is fixed and readable, and a node that says what kind of account
 * it is.
 */
import { buildMoneyMap } from '../utils/financial';

const entity = (id, kind, value) => ({
  id, label: id, kind, tier: kind === 'Entity' ? 'High' : null,
  ifsc: kind === 'Person' ? null : 'KARB0000123', value, inCount: 1, outCount: 1,
});

const sample = () => {
  const people = Array.from({ length: 6 }, (_, i) => entity(`P${i}`, 'Entity', 900000 - i * 100000));
  const mules = Array.from({ length: 8 }, (_, i) => entity(`MULE-${i}`, 'Mule', 200000));
  const shells = Array.from({ length: 5 }, (_, i) => entity(`SHELL-${i}`, 'Shell', 300000));
  const nodes = [...people, ...mules, ...shells];
  const flows = [];
  people.forEach((p, i) => {
    flows.push({ from: p.id, to: mules[i % mules.length].id, value: 50000, count: 3 });
    flows.push({ from: p.id, to: shells[i % shells.length].id, value: 90000, count: 1 });
  });
  return { nodes, flows };
};

test('every node gets a position and a radius the renderer can draw', () => {
  const { nodes, flows } = sample();
  const map = buildMoneyMap(nodes, flows);
  expect(map.nodes).toHaveLength(nodes.length);
  map.nodes.forEach((n) => {
    expect(Number.isFinite(n.x)).toBe(true);
    expect(Number.isFinite(n.y)).toBe(true);
    expect(n.r).toBeGreaterThan(4);
  });
});

test('node size follows the value that passed through, not the id order', () => {
  const { nodes, flows } = sample();
  const map = buildMoneyMap(nodes, flows);
  const by = Object.fromEntries(map.nodes.map((n) => [n.id, n.r]));
  expect(by['P0']).toBeGreaterThan(by['P5']);       // ₹9L vs ₹4L
  expect(by['P5']).toBeGreaterThan(by['MULE-0']);   // ₹4L vs ₹2L
});

test('an edge is a relationship, not a transfer — repeats do not stack', () => {
  const { nodes } = sample();
  // Four payments between the same pair arrive as ONE flow with count 4.
  const map = buildMoneyMap(nodes, [{ from: 'P0', to: 'MULE-0', value: 400000, count: 4 }]);
  expect(map.links).toHaveLength(1);
  expect(map.links[0].count).toBe(4);
});

test('a flow naming an account that is not on the map is dropped, not drawn to nowhere', () => {
  const { nodes } = sample();
  const map = buildMoneyMap(nodes, [
    { from: 'P0', to: 'MULE-0', value: 1, count: 1 },
    { from: 'P0', to: 'GHOST', value: 1, count: 1 },
    { from: 'P0', to: 'P0', value: 1, count: 1 },   // self-transfer
  ]);
  expect(map.links).toHaveLength(1);
  expect(map.links.every((l) => l.s !== l.t)).toBe(true);
});

test('the layout is deterministic — the same money lays out the same way twice', () => {
  const a = buildMoneyMap(...Object.values(sample()).slice(0, 2));
  const { nodes, flows } = sample();
  const b = buildMoneyMap(nodes, flows);
  expect(b.nodes.map((n) => [n.x.toFixed(6), n.y.toFixed(6)]))
    .toEqual(a.nodes.map((n) => [n.x.toFixed(6), n.y.toFixed(6)]));
});

test('nodes are separated enough to be picked apart', () => {
  const { nodes, flows } = sample();
  const map = buildMoneyMap(nodes, flows);
  let touching = 0;
  for (let i = 0; i < map.nodes.length; i++) {
    for (let j = i + 1; j < map.nodes.length; j++) {
      const a = map.nodes[i];
      const b = map.nodes[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < (a.r + b.r) * 0.8) touching++;
    }
  }
  expect(touching).toBe(0);
});

test('a node carries the kind the legend colours it by', () => {
  const { nodes, flows } = sample();
  const map = buildMoneyMap(nodes, flows);
  expect(new Set(map.nodes.map((n) => n.kind))).toEqual(new Set(['Entity', 'Mule', 'Shell']));
  expect(map.entities).toBe(6);
  expect(map.accounts).toBe(13);
});

test('an empty network lays out without throwing', () => {
  const map = buildMoneyMap([], []);
  expect(map.nodes).toEqual([]);
  expect(map.links).toEqual([]);
});
