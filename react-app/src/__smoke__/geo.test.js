/* pointInFeature: the actual point-in-polygon test that replaced
 * bounds.contains() for picking a district's patrol-route candidates.
 * bounds.contains() only tests a shape's RECTANGULAR bounding box — these
 * tests exist because a district is never actually a rectangle.
 */
import { pointInFeature, randomPointInFeature } from '../utils/geo';

const square = {
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]] }, // [lng, lat]
};

test('a point inside a simple square is inside', () => {
  expect(pointInFeature(5, 5, square)).toBe(true); // (lat, lng) = (5, 5)
});

test('a point outside a simple square is outside', () => {
  expect(pointInFeature(15, 15, square)).toBe(false);
});

test('the exact bounding-box bug: a point inside a concave shape\'s bbox but outside the shape itself', () => {
  // An L-shaped district: the notch at (5,5)-(10,10) is NOT part of the
  // district, but IS inside the district's rectangular bounding box —
  // exactly the false positive that let a neighbouring district's hotspot
  // get treated as a valid patrol stop.
  const lShape = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [0, 0], [0, 10], [5, 10], [5, 5], [10, 5], [10, 0], [0, 0],
      ]],
    },
  };
  // (lat=8, lng=8) sits in the notch: inside the 0-10/0-10 bbox, outside the L.
  expect(pointInFeature(8, 8, lShape)).toBe(false);
  // (lat=2, lng=2) is genuinely inside the L.
  expect(pointInFeature(2, 2, lShape)).toBe(true);
});

test('a hole excludes its interior', () => {
  const withHole = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]], // exterior
        [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]], // hole
      ],
    },
  };
  expect(pointInFeature(5, 5, withHole)).toBe(false); // inside the hole
  expect(pointInFeature(1, 1, withHole)).toBe(true); // inside the ring, outside the hole
});

test('MultiPolygon: a point in either part is inside', () => {
  const multi = {
    type: 'Feature',
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [0, 5], [5, 5], [5, 0], [0, 0]]],
        [[[20, 20], [20, 25], [25, 25], [25, 20], [20, 20]]],
      ],
    },
  };
  expect(pointInFeature(2, 2, multi)).toBe(true);
  expect(pointInFeature(22, 22, multi)).toBe(true);
  expect(pointInFeature(12, 12, multi)).toBe(false);
});

test('a feature with no geometry is never matched', () => {
  expect(pointInFeature(5, 5, { type: 'Feature', geometry: null })).toBe(false);
  expect(pointInFeature(5, 5, null)).toBe(false);
});

test('randomPointInFeature always lands inside the shape, not just its bbox', () => {
  const lShape = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[[0, 0], [0, 10], [5, 10], [5, 5], [10, 5], [10, 0], [0, 0]]],
    },
  };
  const bbox = { south: 0, north: 10, west: 0, east: 10 };
  for (let i = 0; i < 50; i++) {
    const pt = randomPointInFeature(lShape, bbox);
    expect(pt).not.toBeNull();
    expect(pointInFeature(pt.lat, pt.lng, lShape)).toBe(true);
  }
});

test('randomPointInFeature gives up and returns null rather than looping forever on an unreachable shape', () => {
  const empty = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } };
  expect(randomPointInFeature(empty, { south: 0, north: 1, west: 0, east: 1 }, 10)).toBeNull();
});
