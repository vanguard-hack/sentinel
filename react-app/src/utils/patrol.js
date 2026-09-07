// Patrol-route optimization for the Crime Map's "Patrol route" toggle, plus
// the question a route like this actually needs answered: does visiting the
// SAME stops in an optimized order help, compared to a random order?
//
// The route actually drawn (optimalOrder, below) is exact-optimal — found by
// brute force — for up to BRUTE_FORCE_LIMIT (8) stops. CrimeMap's MAX_STOPS
// is well above that, to cover most of a district's hotspots rather than a
// handful, so at real-world sizes optimalOrder normally takes its
// nearest-neighbour + 2-opt fallback, not the brute-force path.
// nearestNeighborOrder also remains as the construction step for
// validatePatrolRoute's random-baseline comparison.
//
// The random-baseline method mirrors Kim et al. 2023, "Hotspots-based patrol
// route optimization for smart policing" (Heliyon) — they validate their
// optimized route against random routes two ways: is the tour itself
// shorter, and does it put an officer closer, on average, to a random
// incident in the patrol area. validatePatrolRoute answers the same two
// questions.
//
// One honest difference: Kim et al. measure real travel time from a live
// navigation API reflecting road network and traffic. This is straight-line
// distance, the same simplification the rest of the patrol-route feature
// already uses (there is no road-network data behind Sentinel's map). The
// random-baseline comparison is still meaningful on its own terms — it
// measures whether the ORDERING helps, not whether the underlying distance
// model is road-accurate.

const R_M = 6371000; // Earth radius, metres.

export function haversineMeters(a, b) {
  const rad = Math.PI / 180;
  const dLa = (b.lat - a.lat) * rad;
  const dLo = (b.lng - a.lng) * rad;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function tourLength(order) {
  let m = 0;
  for (let i = 0; i < order.length - 1; i++) m += haversineMeters(order[i], order[i + 1]);
  return m;
}

// Greedy nearest-neighbour tour, starting from the stop nearest `start`.
export function nearestNeighborOrder(stops, start) {
  if (!stops.length) return [];
  const remaining = [...stops];
  const first = remaining.reduce((best, s) =>
    haversineMeters(s, start) < haversineMeters(best, start) ? s : best, remaining[0]);
  const order = [first];
  remaining.splice(remaining.indexOf(first), 1);
  while (remaining.length) {
    const last = order[order.length - 1];
    let nearest = remaining[0];
    remaining.forEach((s) => { if (haversineMeters(last, s) < haversineMeters(last, nearest)) nearest = s; });
    order.push(nearest);
    remaining.splice(remaining.indexOf(nearest), 1);
  }
  return order;
}

// The path length from `start` through an ordered list of stops — same
// convention nearestNeighborOrder anchors on: `start` costs a leg to reach
// the first stop, but isn't itself a stop in the returned order.
function pathLengthFrom(start, order) {
  let m = haversineMeters(start, order[0]);
  for (let i = 0; i < order.length - 1; i++) m += haversineMeters(order[i], order[i + 1]);
  return m;
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

// 2-opt local search: repeatedly reverses a segment of the route whenever
// doing so shortens it, until no such swap is left. Standard TSP-heuristic
// improvement step — cleans up the crossovers a greedy nearest-neighbour
// build tends to leave behind. Used only as the fallback above the size
// brute force stays practical for.
function twoOpt(order, start) {
  let route = [...order];
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        const next = [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)];
        if (pathLengthFrom(start, next) < pathLengthFrom(start, route)) { route = next; improved = true; }
      }
    }
  }
  return route;
}

// The route actually drawn on the map: the exact-optimal stop order for up
// to 8 stops (brute-force over every permutation — 8! = 40,320, trivial at
// this scale) so "optimal" is a literal claim, not an approximation. Above
// that size — MAX_STOPS in CrimeMap.js caps candidates at 8, so this is a
// defensive fallback, not the normal path — nearest-neighbour construction
// plus 2-opt cleanup takes over, since brute force stops being practical.
const BRUTE_FORCE_LIMIT = 8;
export function optimalOrder(stops, start) {
  if (!stops.length) return [];
  if (stops.length === 1) return [...stops];
  if (stops.length > BRUTE_FORCE_LIMIT) return twoOpt(nearestNeighborOrder(stops, start), start);
  let best = null;
  let bestLen = Infinity;
  for (const perm of permutations(stops)) {
    const len = pathLengthFrom(start, perm);
    if (len < bestLen) { bestLen = len; best = perm; }
  }
  return best;
}

// Splits an already-optimal route into `carCount` contiguous legs, one per
// patrol car, so multiple cars can cover the same district at once. Each car
// gets a consecutive stretch of the SAME optimal tour — not a separately
// re-optimized zone — so the split costs nothing over the single-car route;
// it only divides who drives which part of it. Segment sizes are as even as
// possible, with any remainder going to the earliest cars. A car count above
// the stop count is clamped down to one stop per car.
export function splitIntoSegments(order, carCount) {
  if (!order.length) return [];
  const n = Math.max(1, Math.min(Math.floor(carCount) || 1, order.length));
  const base = Math.floor(order.length / n);
  let rem = order.length % n;
  const segments = [];
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem -= 1;
    segments.push(order.slice(idx, idx + size));
    idx += size;
  }
  return segments;
}

// Runs `worker` over `items` with at most `limit` in flight at once. With no
// car-count ceiling, a district split across many cars means many segments
// each wanting their own OpenRouteService road-snap — firing all of them at
// once is what was silently losing most of them to ORS's per-minute rate
// limit (each failure falls back to a straight line, which is why more cars
// meant fewer visible roads). Throttling keeps every segment's request
// actually landing, just staggered instead of simultaneous.
export async function mapWithConcurrency(items, limit, worker) {
  let i = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(lanes);
}

// Deterministic PRNG (mulberry32 — the same generator utils/financial.js
// uses) so the random-order baseline is reproducible across reloads rather
// than flapping the reported savings every render.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Where a random moment finds the officer along the route — weighted by leg
// length, a straight-line stand-in for travel time, the same idea as Kim et
// al.'s Eq. 8: a longer leg is more likely to be where transit catches you.
function pointOnRoute(order, rnd) {
  if (order.length === 1) return order[0];
  const segs = [];
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) {
    const d = haversineMeters(order[i], order[i + 1]);
    segs.push(d);
    total += d;
  }
  if (!total) return order[0];
  let r = rnd() * total;
  for (let i = 0; i < segs.length; i++) {
    if (r <= segs[i] || i === segs.length - 1) {
      const t = segs[i] ? r / segs[i] : 0;
      return {
        lat: order[i].lat + (order[i + 1].lat - order[i].lat) * t,
        lng: order[i].lng + (order[i + 1].lng - order[i].lng) * t,
      };
    }
    r -= segs[i];
  }
  return order[order.length - 1];
}

/**
 * Does the optimized order actually help, against `trials` random orderings
 * of the SAME stops? Two comparisons, both seeded for reproducibility:
 *   - tour length: is the loop itself shorter;
 *   - response distance: averaged over `incidentSamples` random incident
 *     points in the stops' bounding box, how far is a random moment on the
 *     patrol from that incident, on this route vs. a randomly-ordered one.
 *
 * The same `incidents` sample is scored against every route compared, so the
 * routes are judged against identical test points — not each against its own
 * easier or harder draw.
 */
export function validatePatrolRoute(stops, { start, trials = 20, incidentSamples = 150, seed = 20260907 } = {}) {
  if (!stops || stops.length < 2) return null;
  const rnd = mulberry32(seed);
  const centre = start || {
    lat: stops.reduce((s, p) => s + p.lat, 0) / stops.length,
    lng: stops.reduce((s, p) => s + p.lng, 0) / stops.length,
  };
  const optimized = nearestNeighborOrder(stops, centre);

  const lats = stops.map((s) => s.lat);
  const lngs = stops.map((s) => s.lng);
  const padLat = Math.max(0.01, (Math.max(...lats) - Math.min(...lats)) * 0.2);
  const padLng = Math.max(0.01, (Math.max(...lngs) - Math.min(...lngs)) * 0.2);
  const b = {
    latMin: Math.min(...lats) - padLat, latMax: Math.max(...lats) + padLat,
    lngMin: Math.min(...lngs) - padLng, lngMax: Math.max(...lngs) + padLng,
  };
  const incidents = Array.from({ length: incidentSamples }, () => ({
    lat: b.latMin + rnd() * (b.latMax - b.latMin),
    lng: b.lngMin + rnd() * (b.lngMax - b.lngMin),
  }));

  const responseDistance = (order) => {
    let sum = 0;
    incidents.forEach((incident) => { sum += haversineMeters(pointOnRoute(order, rnd), incident); });
    return sum / incidents.length;
  };

  const optimizedKm = tourLength(optimized) / 1000;
  const optimizedResponseM = responseDistance(optimized);

  let randomKmTotal = 0;
  let randomResponseTotal = 0;
  for (let t = 0; t < trials; t++) {
    const order = shuffled(stops, rnd);
    randomKmTotal += tourLength(order) / 1000;
    randomResponseTotal += responseDistance(order);
  }
  const randomAvgKm = randomKmTotal / trials;
  const randomAvgResponseM = randomResponseTotal / trials;

  return {
    order: optimized,
    optimizedKm, randomAvgKm,
    tourSavingsPct: randomAvgKm > 0 ? (1 - optimizedKm / randomAvgKm) * 100 : 0,
    optimizedResponseM, randomAvgResponseM,
    responseSavingsPct: randomAvgResponseM > 0 ? (1 - optimizedResponseM / randomAvgResponseM) * 100 : 0,
    trials, incidentSamples,
  };
}

// Road-snapped preview: ask the backend (which proxies OpenRouteService) for
// the actual road geometry between these stops, in the same order the
// nearest-neighbour heuristic already picked. Best-effort — no key
// configured, a timeout, or any ORS error all resolve to `null`, and the
// caller keeps drawing the straight-line route it already has.
export async function fetchRoadRoute(stops) {
  if (!stops || stops.length < 2) return null;
  try {
    const res = await fetch('/server/rag/patrol/directions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stops: stops.map((s) => ({ lat: s.lat, lng: s.lng })) }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || !data.available) return null;
    return { coordinates: data.coordinates, distanceKm: data.distanceKm, durationMin: data.durationMin };
  } catch {
    return null;
  }
}

// Hand off "navigate this route" to Google Maps — turn-by-turn voice
// guidance, live traffic and rerouting are Google's job, not something to
// rebuild in-map. Waypoints go in visiting order; the last stop becomes the
// destination. When `originCoords` is omitted the Google Maps app fills in
// the device's current location on its own.
export function buildGoogleMapsNavUrl(stops, originCoords) {
  if (!stops || stops.length < 1) return null;
  const destination = stops[stops.length - 1];
  const waypoints = stops.slice(0, -1).map((s) => `${s.lat},${s.lng}`).join('|');
  const params = new URLSearchParams({
    api: '1',
    destination: `${destination.lat},${destination.lng}`,
    travelmode: 'driving',
  });
  if (waypoints) params.set('waypoints', waypoints);
  if (originCoords) params.set('origin', `${originCoords.lat},${originCoords.lng}`);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

// Wraps the browser geolocation callback in a promise with a short timeout,
// so a slow or denied permission prompt can't hang a "Navigate" click — it
// resolves to null instead, and buildGoogleMapsNavUrl leaves origin unset.
export function currentLocation({ timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: timeoutMs, maximumAge: 60_000 }
    );
  });
}
