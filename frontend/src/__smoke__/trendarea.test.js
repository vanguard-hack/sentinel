/* trendSegments: splits a TrendArea series into a solid (measured) run and
 * up to two dashed runs — a LEADING one for `illustrative: true` points (a
 * placeholder backdrop with no real record behind it) and a TRAILING one for
 * `forecast: true` points, each drawn as its own path so a line never jumps
 * straight across the solid segment between them.
 */
import { trendSegments } from '../components/charts/TrendArea';

const pt = (value, flags = {}) => ({ label: String(value), value, ...flags });

test('with no forecast and no illustrative points, everything is solid — unchanged from before either flag existed', () => {
  const data = [pt(1), pt(2), pt(3)];
  const { solid, leadDashed, trailDashed } = trendSegments(data);
  expect(solid.map((d) => d.value)).toEqual([1, 2, 3]);
  expect(leadDashed).toEqual([]);
  expect(trailDashed).toEqual([]);
});

test('a trailing forecast run is dashed and overlaps the solid run by one point', () => {
  const data = [pt(1), pt(2), pt(3), pt(4, { forecast: true }), pt(5, { forecast: true })];
  const { solid, leadDashed, trailDashed } = trendSegments(data);
  expect(solid.map((d) => d.value)).toEqual([1, 2, 3]);
  expect(leadDashed).toEqual([]);
  expect(trailDashed.map((d) => d.value)).toEqual([3, 4, 5]); // includes the join point (3)
});

test('a leading illustrative run is dashed and overlaps the solid run by one point', () => {
  const data = [pt(10, { illustrative: true }), pt(11, { illustrative: true }), pt(20), pt(21)];
  const { solid, leadDashed, trailDashed } = trendSegments(data);
  expect(leadDashed.map((d) => d.value)).toEqual([10, 11, 20]); // includes the join point (20)
  expect(solid.map((d) => d.value)).toEqual([20, 21]);
  expect(trailDashed).toEqual([]);
});

test('illustrative lead, solid middle, and forecast trail all coexist without a spurious connecting segment', () => {
  const data = [
    pt(10, { illustrative: true }), pt(11, { illustrative: true }),
    pt(20), pt(21), pt(22),
    pt(30, { forecast: true }), pt(31, { forecast: true }),
  ];
  const { solid, leadDashed, trailDashed } = trendSegments(data);
  expect(leadDashed.map((d) => d.value)).toEqual([10, 11, 20]);
  expect(solid.map((d) => d.value)).toEqual([20, 21, 22]);
  expect(trailDashed.map((d) => d.value)).toEqual([22, 30, 31]);
  // The two dashed runs never share an array — nothing bridges 11 straight to 30.
  expect(leadDashed).not.toBe(trailDashed);
});

test('every point flagged illustrative is treated as the whole lead-in, not a crash', () => {
  const data = [pt(1, { illustrative: true }), pt(2, { illustrative: true })];
  const { solid, leadDashed } = trendSegments(data);
  expect(leadDashed.map((d) => d.value)).toEqual([1, 2]);
  expect(solid).toEqual([]);
});
