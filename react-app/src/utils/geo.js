// Point-in-polygon test against a GeoJSON feature's actual geometry
// (Polygon or MultiPolygon) — standard ray-casting with the even-odd rule,
// so a hole (any ring after the first in a Polygon) correctly excludes its
// interior.
//
// Leaflet's `bounds.contains()` only tests a shape's RECTANGULAR bounding
// box. A district is never actually a rectangle, so a point can sit inside
// the bbox while genuinely belonging to a neighbouring district — that
// false positive is what let the Crime Map's patrol route pick hotspots
// outside the clicked district. This is the check that respects the shape.

function ringContains(ring, lat, lng) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; // GeoJSON coordinates are [lng, lat]
    const [xj, yj] = ring[j];
    const crosses = (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function polygonContains(rings, lat, lng) {
  if (!rings.length || !ringContains(rings[0], lat, lng)) return false;
  for (let i = 1; i < rings.length; i++) {
    if (ringContains(rings[i], lat, lng)) return false; // inside a hole
  }
  return true;
}

export function pointInFeature(lat, lng, feature) {
  const geom = feature?.geometry;
  if (!geom) return false;
  if (geom.type === 'Polygon') return polygonContains(geom.coordinates, lat, lng);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some((poly) => polygonContains(poly, lat, lng));
  return false;
}
