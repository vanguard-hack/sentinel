/* Patrol-route optimization: does the nearest-neighbour order actually beat
 * a random order, on the two measures Kim et al. 2023 (Heliyon) validate
 * against — tour length and average response distance to a random incident?
 */
import {
  haversineMeters, tourLength, nearestNeighborOrder, validatePatrolRoute,
  fetchRoadRoute, buildGoogleMapsNavUrl, optimalOrder, splitIntoSegments, mapWithConcurrency,
} from '../utils/patrol';

const ok = (body) => ({ ok: true, json: async () => body });
afterEach(() => { delete global.fetch; });

test('haversine of a point to itself is zero', () => {
  const p = { lat: 12.97, lng: 77.59 };
  expect(haversineMeters(p, p)).toBe(0);
});

test('haversine is symmetric and roughly matches a known Bengaluru-Mysuru distance', () => {
  const blr = { lat: 12.9716, lng: 77.5946 };
  const mys = { lat: 12.2958, lng: 76.6394 };
  const d = haversineMeters(blr, mys) / 1000;
  expect(haversineMeters(mys, blr) / 1000).toBeCloseTo(d, 6);
  // Straight-line Bengaluru-Mysuru is roughly 130-145 km.
  expect(d).toBeGreaterThan(120);
  expect(d).toBeLessThan(150);
});

test('nearest-neighbour order visits every stop exactly once', () => {
  const stops = [
    { lat: 12.97, lng: 77.59 }, { lat: 12.30, lng: 76.65 },
    { lat: 15.36, lng: 75.12 }, { lat: 12.91, lng: 74.86 },
  ];
  const order = nearestNeighborOrder(stops, { lat: 13, lng: 77 });
  expect(order).toHaveLength(stops.length);
  const seen = new Set(order.map((s) => `${s.lat},${s.lng}`));
  expect(seen.size).toBe(stops.length);
});

test('optimalOrder visits every stop exactly once', () => {
  const stops = [
    { lat: 12.97, lng: 77.59 }, { lat: 12.30, lng: 76.65 },
    { lat: 15.36, lng: 75.12 }, { lat: 12.91, lng: 74.86 },
  ];
  const order = optimalOrder(stops, { lat: 13, lng: 77 });
  expect(order).toHaveLength(stops.length);
  const seen = new Set(order.map((s) => `${s.lat},${s.lng}`));
  expect(seen.size).toBe(stops.length);
});

test('optimalOrder finds the exact shortest path — the input order gives no hint', () => {
  // Colinear points, deliberately shuffled: the only path of minimal length
  // visits them in distance-from-start order, whichever order they're given
  // in — a brute-force search has no excuse to miss it.
  const start = { lat: 0, lng: 0 };
  const A = { lat: 0, lng: 1 };
  const B = { lat: 0, lng: 2 };
  const C = { lat: 0, lng: 3 };
  const order = optimalOrder([C, A, B], start);
  expect(order.map((s) => s.lng)).toEqual([1, 2, 3]);
});

test('optimalOrder is never longer than the nearest-neighbour construction it replaces', () => {
  const start = { lat: 13.0, lng: 77.0 };
  const stops = [
    { lat: 12.97, lng: 77.59 }, { lat: 12.30, lng: 76.65 }, { lat: 15.36, lng: 75.12 },
    { lat: 12.91, lng: 74.86 }, { lat: 14.50, lng: 76.00 }, { lat: 13.80, lng: 75.30 },
  ];
  const nnLen = tourLength([start, ...nearestNeighborOrder(stops, start)]);
  const optLen = tourLength([start, ...optimalOrder(stops, start)]);
  expect(optLen).toBeLessThanOrEqual(nnLen + 1e-6);
});

test('splitIntoSegments covers every stop exactly once, in order, across contiguous segments', () => {
  const order = Array.from({ length: 7 }, (_, i) => ({ lat: i, lng: i }));
  const segments = splitIntoSegments(order, 3);
  expect(segments).toHaveLength(3);
  expect(segments.map((s) => s.length)).toEqual([3, 2, 2]); // remainder goes to the earliest cars
  expect(segments.flat()).toEqual(order); // concatenation reproduces the original order exactly
});

test('splitIntoSegments with one car returns the whole route as a single segment', () => {
  const order = Array.from({ length: 5 }, (_, i) => ({ lat: i, lng: i }));
  expect(splitIntoSegments(order, 1)).toEqual([order]);
});

test('splitIntoSegments clamps a car count above the stop count down to one stop per car', () => {
  const order = Array.from({ length: 3 }, (_, i) => ({ lat: i, lng: i }));
  const segments = splitIntoSegments(order, 10);
  expect(segments).toHaveLength(3);
  expect(segments.every((s) => s.length === 1)).toBe(true);
});

test('mapWithConcurrency runs every item exactly once, in the given order of completion tracking', async () => {
  const seen = [];
  await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); });
  expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
});

test('mapWithConcurrency never runs more than `limit` workers at once', async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 9 }, (_, i) => i);
  await mapWithConcurrency(items, 3, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });
  expect(maxActive).toBeLessThanOrEqual(3);
});

test('mapWithConcurrency with more lanes than items still runs each item once', async () => {
  const seen = [];
  await mapWithConcurrency(['a', 'b'], 10, async (item) => { seen.push(item); });
  expect(seen.sort()).toEqual(['a', 'b']);
});

test('a route clustered along a line beats scattering the same stops randomly', () => {
  // Four stops laid out on a near-straight line: any sane order that walks
  // it end-to-end is close to optimal, and a random shuffle regularly
  // doubles back across the line, so the optimized tour should be shorter.
  const stops = [
    { lat: 12.00, lng: 77.00 },
    { lat: 12.01, lng: 77.00 },
    { lat: 12.02, lng: 77.00 },
    { lat: 12.03, lng: 77.00 },
    { lat: 12.04, lng: 77.00 },
    { lat: 12.05, lng: 77.00 },
  ];
  const v = validatePatrolRoute(stops, { start: { lat: 12.00, lng: 77.00 }, trials: 40, incidentSamples: 60 });
  expect(v.optimizedKm).toBeLessThan(v.randomAvgKm);
  expect(v.tourSavingsPct).toBeGreaterThan(0);
});

test('is deterministic given the same seed', () => {
  const stops = [
    { lat: 12.97, lng: 77.59 }, { lat: 13.34, lng: 77.10 },
    { lat: 12.52, lng: 76.90 }, { lat: 15.85, lng: 74.50 }, { lat: 17.33, lng: 76.83 },
  ];
  const a = validatePatrolRoute(stops, { seed: 42 });
  const b = validatePatrolRoute(stops, { seed: 42 });
  expect(a).toEqual(b);
});

test('fewer than two stops is reported as no measurement, not a zero', () => {
  expect(validatePatrolRoute([])).toBeNull();
  expect(validatePatrolRoute([{ lat: 12, lng: 77 }])).toBeNull();
});

test('tourLength sums consecutive-leg haversine distances', () => {
  const order = [{ lat: 12, lng: 77 }, { lat: 12.1, lng: 77 }, { lat: 12.1, lng: 77.1 }];
  const expected = haversineMeters(order[0], order[1]) + haversineMeters(order[1], order[2]);
  expect(tourLength(order)).toBeCloseTo(expected, 6);
});

test('the Google Maps URL puts the last stop as destination and the rest as ordered waypoints', () => {
  const stops = [{ lat: 12.97, lng: 77.59 }, { lat: 12.99, lng: 77.60 }, { lat: 13.01, lng: 77.62 }];
  const url = new URL(buildGoogleMapsNavUrl(stops, { lat: 12.90, lng: 77.50 }));
  expect(url.searchParams.get('destination')).toBe('13.01,77.62');
  expect(url.searchParams.get('waypoints')).toBe('12.97,77.59|12.99,77.6');
  expect(url.searchParams.get('origin')).toBe('12.9,77.5');
});

test('the Google Maps URL omits origin when none is given, so the app fills in "my location"', () => {
  const stops = [{ lat: 12.97, lng: 77.59 }, { lat: 12.99, lng: 77.60 }];
  const url = new URL(buildGoogleMapsNavUrl(stops, null));
  expect(url.searchParams.has('origin')).toBe(false);
});

test('fetchRoadRoute returns null when the backend has no ORS key configured', async () => {
  global.fetch = jest.fn(async () => ok({ available: false }));
  const stops = [{ lat: 12.97, lng: 77.59 }, { lat: 12.99, lng: 77.60 }];
  expect(await fetchRoadRoute(stops)).toBeNull();
});

test('fetchRoadRoute returns the road geometry and distance when ORS answers', async () => {
  global.fetch = jest.fn(async () => ok({
    available: true, coordinates: [[12.97, 77.59], [12.99, 77.60]], distanceKm: 4.2, durationMin: 9,
  }));
  const stops = [{ lat: 12.97, lng: 77.59 }, { lat: 12.99, lng: 77.60 }];
  const result = await fetchRoadRoute(stops);
  expect(result).toEqual({ coordinates: [[12.97, 77.59], [12.99, 77.60]], distanceKm: 4.2, durationMin: 9 });
});

test('fetchRoadRoute fails soft — a network error is null, not a throw', async () => {
  global.fetch = jest.fn(async () => { throw new Error('offline'); });
  const stops = [{ lat: 12.97, lng: 77.59 }, { lat: 12.99, lng: 77.60 }];
  await expect(fetchRoadRoute(stops)).resolves.toBeNull();
});
