/* Case-linkage validation: made faster and non-blocking, without moving the
 * number it reports.
 *
 * The hit-rate half scores 120 index cases against every case in the set. At
 * 30,000 cases that is 3.6 million comparisons and roughly four seconds of
 * unbroken main-thread work — and it used to run inside a render, so the tab
 * painted nothing at all until it finished.
 *
 * Two things changed, and both are the kind of change that can silently alter a
 * published accuracy figure:
 *   · the top-10 is now selected in one pass instead of scoring everything into
 *     an array and sorting it;
 *   · the work yields to the browser between index cases.
 * These tests exist to prove neither of them moved the answer.
 */
import { validate, validateAsync, scorePair, pairScore } from '../utils/caselinkage';

// A small, fully deterministic linkage set: 60 cases, six three-case series.
function makeData(n = 60) {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const VOCAB = ['night', 'motorcycle', 'market', 'forced', 'window', 'cash', 'alone', 'knife'];

  const cases = Array.from({ length: n }, (_, i) => {
    const series = i % 20;                       // cases sharing i%20 are a series
    const feats = new Set([`s${series}`, VOCAB[Math.floor(rnd() * VOCAB.length)]]);
    if (rnd() < 0.5) feats.add(VOCAB[Math.floor(rnd() * VOCAB.length)]);
    return {
      id: `c${i}`,
      crimeNo: `CR/${i}`,
      features: feats,
      lat: 12 + rnd() * 2,
      lon: 74 + rnd() * 2,
      ts: Date.UTC(2025, i % 12, 1 + (i % 27)),
      district: `D${i % 4}`,
      station: `PS${i % 8}`,
      type: 'Theft',
    };
  });
  const byId = new Map(cases.map((c) => [c.id, c]));

  const linkedPairs = new Set();
  for (let s = 0; s < 20; s++) {
    const members = cases.filter((_, i) => i % 20 === s).map((c) => c.id);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const [a, b] = members[i] < members[j] ? [members[i], members[j]] : [members[j], members[i]];
        linkedPairs.add(`${a}|${b}`);
      }
    }
  }
  return { cases, byId, linkedPairs };
}

/* The implementation this replaced: score every candidate into an array, sort
   it, take ten. Array.sort is stable, so ties keep input order — which is the
   property the one-pass selection has to reproduce. */
function referenceHitRate(data, hitSample = 120) {
  const { cases, byId, linkedPairs } = data;
  const seriesMates = new Map();
  linkedPairs.forEach((key) => {
    const [a, b] = key.split('|');
    (seriesMates.get(a) || seriesMates.set(a, new Set()).get(a)).add(b);
    (seriesMates.get(b) || seriesMates.set(b, new Set()).get(b)).add(a);
  });
  const seriesCases = [...seriesMates.keys()];
  const step = Math.max(1, Math.floor(seriesCases.length / hitSample));
  let hits = 0;
  let tried = 0;
  for (let s = 0; s < seriesCases.length && tried < hitSample; s += step) {
    const idx = byId.get(seriesCases[s]);
    const mates = seriesMates.get(idx.id);
    const top = cases
      .filter((c) => c.id !== idx.id)
      .map((c) => ({ id: c.id, score: scorePair(idx, c).score }))
      .sort((x, y) => y.score - x.score)
      .slice(0, 10);
    if (top.some((t) => mates.has(t.id))) hits++;
    tried++;
  }
  return tried ? hits / tried : null;
}

test('the one-pass top-10 reports the same hit rate as scoring and sorting', () => {
  const data = makeData();
  expect(validate(data).hitRate).toBe(referenceHitRate(data));
});

test('and still does with every score tied, where selection order is all there is', () => {
  // Identical features, coordinates and dates: every pair scores the same, so
  // only the tie-breaking rule decides which ten come back.
  const data = makeData();
  data.cases.forEach((c) => {
    c.features = new Set(['same']);
    c.lat = 12; c.lon = 74;
    c.ts = Date.UTC(2025, 0, 1);
  });
  expect(validate(data).hitRate).toBe(referenceHitRate(data));
});

test('pairScore is scorePair.score — it just does not allocate to say so', () => {
  const { cases } = makeData(12);
  for (const a of cases) {
    for (const b of cases) expect(pairScore(a, b)).toBe(scorePair(a, b).score);
  }
});

test('the yielding run returns exactly what the blocking one does', async () => {
  const data = makeData();
  expect(await validateAsync(data)).toEqual(validate(data));
});

test('the yielding run really does hand the browser back', async () => {
  const data = makeData();
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  // sliceMs 0 forces a yield between every index case.
  await validateAsync(data, undefined, { sliceMs: 0 });
  clearInterval(timer);
  // A blocking loop starves the timer entirely; a yielding one lets it run.
  expect(ticks).toBeGreaterThan(0);
});

test('an empty set is reported as no measurement, not as a zero', () => {
  const empty = { cases: [], byId: new Map(), linkedPairs: new Set() };
  expect(validate(empty)).toEqual({ auc: null, hitRate: null, linkedPairs: 0, seriesCases: 0 });
});
