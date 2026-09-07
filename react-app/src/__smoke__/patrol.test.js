/* Patrol-route optimization: does the nearest-neighbour order actually beat
 * a random order, on the two measures Kim et al. 2023 (Heliyon) validate
 * against — tour length and average response distance to a random incident?
 */
import { haversineMeters, tourLength, nearestNeighborOrder, validatePatrolRoute } from '../utils/patrol';

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
