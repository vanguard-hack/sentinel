/* Overview layout + explorer default view. */
import { buildOverview } from '../utils/crimelinks';

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

test('overview lays out every ring with no shared nodes between them', () => {
  const nets = [mkRing('a', 20, 'Kodagu', 'Theft'), mkRing('b', 4, 'Udupi', 'Cheating'), mkRing('c', 3, 'Gadag', 'Rash Driving')];
  nets.forEach((n, i) => { n.rank = i + 1; });
  const ov = buildOverview(nets);

  expect(ov.nodes).toHaveLength(27);
  expect(ov.rings).toHaveLength(3);
  // every node belongs to exactly one ring — rings are connected components,
  // so membership cannot overlap
  const ids = new Set(ov.nodes.map((n) => n.id));
  expect(ids.size).toBe(ov.nodes.length);
  // links only ever join nodes inside the same ring
  ov.links.forEach((l) => {
    expect(ov.nodes[l.s].ring).toBe(ov.nodes[l.t].ring);
  });
});

test('ring centres are scattered, not on a regular curve', () => {
  // The spiral packing this replaced produced centres whose distance from the
  // middle grew monotonically — visibly mathematical. Real scatter should not.
  const nets = Array.from({ length: 60 }, (_, i) => mkRing(`r${i}`, 4, `D${i % 8}`, 'Theft'));
  nets.forEach((n, i) => { n.rank = i + 1; });
  const { rings } = buildOverview(nets);
  const cx = rings.reduce((a, r) => a + r.cx, 0) / rings.length;
  const cy = rings.reduce((a, r) => a + r.cy, 0) / rings.length;
  const d = rings.map((r) => Math.hypot(r.cx - cx, r.cy - cy));
  let monotonic = 0;
  for (let i = 1; i < d.length; i++) if (d[i] > d[i - 1]) monotonic++;
  // A spiral gives ~100% increasing; scattered placement should be near chance.
  expect(monotonic / (d.length - 1)).toBeLessThan(0.75);
});

test('rings do not sit on top of each other', () => {
  const nets = Array.from({ length: 40 }, (_, i) => mkRing(`r${i}`, i < 5 ? 15 : 4, 'D', 'Theft'));
  nets.forEach((n, i) => { n.rank = i + 1; });
  const { rings } = buildOverview(nets);
  let overlaps = 0;
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      const dist = Math.hypot(rings[i].cx - rings[j].cx, rings[i].cy - rings[j].cy);
      if (dist < (rings[i].r + rings[j].r) * 0.8) overlaps++;
    }
  }
  // dart-throwing falls back after 60 tries, so allow a couple of near-misses
  expect(overlaps).toBeLessThan(4);
});

test('most rings are joined into connected groups, a few stand alone', () => {
  // districts and crime types repeat across rings, as in the real data
  const DISTRICTS = ['Kodagu', 'Udupi', 'Gadag', 'Hassan', 'Mysuru'];
  const TYPES = ['Theft', 'Cheating', 'Rash Driving'];
  const nets = Array.from({ length: 120 }, (_, i) =>
    mkRing(`r${i}`, i < 8 ? 16 - i : 4, DISTRICTS[i % DISTRICTS.length], TYPES[i % TYPES.length]));
  // a handful with a district and type all of their own — these should stay isolated
  nets.push(mkRing('lone1', 3, 'Lonely', 'Unique Offence'));
  nets.push(mkRing('lone2', 3, 'Solitary', 'Odd Offence'));
  nets.forEach((n, i) => { n.rank = i + 1; });

  const ov = buildOverview(nets);
  expect(ov.interLinks.length).toBeGreaterThan(0);
  // the great majority of rings hang together
  const joined = nets.length - ov.isolated;
  expect(joined / nets.length).toBeGreaterThan(0.9);
  // but a genuinely unique ring is not forced into a group
  expect(ov.isolated).toBeGreaterThan(0);
});

test('ring links only ever join hubs of different rings', () => {
  const nets = [
    mkRing('a', 6, 'Kodagu', 'Theft'),
    mkRing('b', 5, 'Kodagu', 'Theft'),
    mkRing('c', 4, 'Udupi', 'Theft'),
  ];
  nets.forEach((n, i) => { n.rank = i + 1; });
  const ov = buildOverview(nets);
  ov.interLinks.forEach((l) => {
    expect(ov.nodes[l.s].ring).not.toBe(ov.nodes[l.t].ring);
    // and they are attribute links, never claims of co-offending
    expect(['district', 'type']).toContain(l.kind);
  });
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
  expect(ov.rings).toHaveLength(500);
  expect(ov.nodes.length).toBeGreaterThan(1800);
  // layout is O(n): comfortably under a second even for the full set
  expect(Date.now() - t0).toBeLessThan(1500);
});
