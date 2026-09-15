/* Overview layout + explorer default view. */
import { buildOverview, networkToSpec } from '../utils/crimelinks';

const mkRing = (id, size, district, type) => {
  const members = Array.from({ length: size }, (_, i) => ({
    pid: `${id}-p${i}`, name: `P${i}`, district, degree: i === 0 ? size - 1 : 1,
  }));
  const edges = members.slice(1).map((m) => ({ source: members[0].pid, target: m.pid, weight: 1 }));
  return {
    id, size, members, edges, caseIds: [], district, topType: type,
    leader: members[0], rank: 0, dateFrom: '', dateTo: '',
  };
};

test('overview draws one labelled node per ring, not per person', () => {
  const nets = [mkRing('a', 20, 'Kodagu', 'Theft'), mkRing('b', 4, 'Udupi', 'Cheating'), mkRing('c', 3, 'Gadag', 'Theft')];
  nets.forEach((n, i) => { n.rank = i + 1; });
  const ov = buildOverview(nets);

  // three rings → three nodes, even though they hold 27 people between them
  expect(ov.nodes).toHaveLength(3);
  expect(ov.nodes.every((n) => n.label && /ring/.test(n.label))).toBe(true);
  // node size carries membership
  expect(ov.nodes[0].size).toBe(20);
  expect(ov.nodes[0].r).toBeGreaterThan(ov.nodes[1].r);
});

test('only the largest rings are drawn, the rest stay in the sidebar', () => {
  const nets = Array.from({ length: 200 }, (_, i) => mkRing(`r${i}`, Math.max(3, 25 - i), 'Kodagu', 'Theft'));
  nets.forEach((n, i) => { n.rank = i + 1; });
  const ov = buildOverview(nets, { topN: 40 });
  expect(ov.nodes).toHaveLength(40);
  expect(ov.total).toBe(200);
  expect(ov.shown).toBe(40);
});

test('most rings are joined into connected groups, a few stand alone', () => {
  const DISTRICTS = ['Kodagu', 'Udupi', 'Gadag', 'Hassan', 'Mysuru'];
  const TYPES = ['Theft', 'Cheating', 'Rash Driving'];
  const nets = Array.from({ length: 40 }, (_, i) =>
    mkRing(`r${i}`, i < 6 ? 16 - i : 4, DISTRICTS[i % DISTRICTS.length], TYPES[i % TYPES.length]));
  nets.push(mkRing('lone1', 3, 'Lonely', 'Unique Offence'));
  nets.forEach((n, i) => { n.rank = i + 1; });
  const ov = buildOverview(nets, { topN: 41 });
  expect(ov.links.length).toBeGreaterThan(0);
  expect((ov.nodes.length - ov.isolated) / ov.nodes.length).toBeGreaterThan(0.9);
  expect(ov.isolated).toBeGreaterThan(0);
});

test('ring links only ever join two different rings', () => {
  const nets = [
    mkRing('a', 6, 'Kodagu', 'Theft'),
    mkRing('b', 5, 'Kodagu', 'Theft'),
    mkRing('c', 4, 'Udupi', 'Theft'),
  ];
  nets.forEach((n, i) => { n.rank = i + 1; });
  const ov = buildOverview(nets);
  ov.links.forEach((l) => {
    expect(l.s).not.toBe(l.t);
    expect(['district', 'type']).toContain(l.kind);
  });
});

test('nodes do not overlap after layout', () => {
  const nets = Array.from({ length: 45 }, (_, i) => mkRing(`r${i}`, i < 5 ? 15 : 4, `D${i % 6}`, 'Theft'));
  nets.forEach((n, i) => { n.rank = i + 1; });
  const { nodes } = buildOverview(nets);
  let overlaps = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) < (nodes[i].r + nodes[j].r) * 0.9) overlaps++;
    }
  }
  expect(overlaps).toBeLessThan(3);
});

test('layout is deterministic and bounded', () => {
  const nets = [mkRing('a', 6, 'Kodagu', 'Theft'), mkRing('b', 3, 'Udupi', 'Cheating')];
  nets.forEach((n, i) => { n.rank = i + 1; });
  const a = buildOverview(nets);
  const b = buildOverview(nets);
  expect(a.nodes.map((n) => [Math.round(n.x), Math.round(n.y)]))
    .toEqual(b.nodes.map((n) => [Math.round(n.x), Math.round(n.y)]));
  a.nodes.forEach((n) => {
    expect(Number.isFinite(n.x)).toBe(true);
    expect(n.x).toBeGreaterThanOrEqual(0);
    expect(n.x).toBeLessThanOrEqual(1100);
  });
});

test('scales to many rings without blowing up', () => {
  // power-law-ish sizes, like the real data
  const nets = Array.from({ length: 500 }, (_, i) => {
    const size = i < 12 ? 20 - i : i < 90 ? 6 : 3;
    return mkRing(`r${i}`, size, `D${i % 30}`, 'Theft');
  });
  nets.forEach((n, i) => { n.rank = i + 1; });
  const t0 = Date.now();
  const ov = buildOverview(nets);
  expect(ov.total).toBe(500);
  expect(ov.nodes.length).toBeLessThanOrEqual(70);
  // layout is O(n): comfortably under a second even for the full set
  expect(Date.now() - t0).toBeLessThan(1500);
});

test('ring detail renders the whole ring — no trimming, no dropped edges', () => {
  // Previously capped at 60 members, which also silently dropped every edge
  // touching a trimmed member, so the graph disagreed with its own header.
  const big = mkRing('big', 90, 'Kodagu', 'Theft');
  const spec = networkToSpec(big);
  expect(spec.nodes).toHaveLength(big.members.length);
  expect(spec.links).toHaveLength(big.edges.length);
  expect(spec.trimmed).toBe(0);
  // every link still refers to a node that is actually rendered
  const ids = new Set(spec.nodes.map((n) => n.id));
  spec.links.forEach((l) => {
    expect(ids.has(l.source)).toBe(true);
    expect(ids.has(l.target)).toBe(true);
  });
});

test('node size tracks ring membership, and nodes are large enough to read', () => {
  const nets = [mkRing('big', 20, 'Kodagu', 'Theft'), mkRing('mid', 9, 'Udupi', 'Theft'), mkRing('small', 3, 'Gadag', 'Theft')];
  nets.forEach((n, i) => { n.rank = i + 1; });
  const { nodes } = buildOverview(nets);
  const [big, mid, small] = nodes;
  expect(big.r).toBeGreaterThan(mid.r);
  expect(mid.r).toBeGreaterThan(small.r);
  // meaningfully bigger than the old dot-sized nodes
  expect(small.r).toBeGreaterThan(8);
});

test('focusing does not move anything — layout depends only on the data', () => {
  const nets = Array.from({ length: 25 }, (_, i) => mkRing(`r${i}`, i < 4 ? 14 - i : 4, `D${i % 5}`, 'Theft'));
  nets.forEach((n, i) => { n.rank = i + 1; });
  // buildOverview takes no selection argument at all, so a click cannot
  // possibly re-run the layout with different positions
  const a = buildOverview(nets).nodes.map((n) => [Math.round(n.x), Math.round(n.y), Math.round(n.r)]);
  const b = buildOverview(nets).nodes.map((n) => [Math.round(n.x), Math.round(n.y), Math.round(n.r)]);
  expect(a).toEqual(b);
});

