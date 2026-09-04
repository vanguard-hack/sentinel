// Behavioural case linkage (comparative case analysis).
//
// Implements the crime-linkage method the research literature converged on:
//   • each crime is coded into binary behavioural features (offence type, MO
//     tokens, target/place selection, timing) and pairs of crimes are scored
//     with Jaccard's coefficient — the standard similarity measure, chosen
//     because it ignores joint non-occurrence: in police data the absence of a
//     behaviour may just mean it was not recorded (Bennell & Canter, 2002);
//   • inter-crime distance (haversine km) and temporal proximity (days
//     between offences) — the two most consistently predictive linkage
//     domains across studies (Bennell et al., 2014);
//   • the three domain scores combine into one ranked candidate list for an
//     index offence — the "comparative case analysis" task analysts actually
//     perform (Burrell, Costello & Woodhams, 2024);
//   • accuracy is validated on ground truth the way the literature demands:
//     pairs of cases sharing a global offender PersonID are true links, and
//     the score's discrimination is reported as ROC AUC plus a ranked-list
//     hit rate.
//
// ZCQL has no joins, so tables are paged down and stitched client-side.

import { assess, applyIsotonic, isotonicSupport } from './calibration';

import { fetchSnapshotTable } from './datastore';
import { derived, invalidate } from './derived';
import { afterPaint, breathe } from './idle';


// Paging lives in datastore.pageQuery, which reports when it stopped short.
// Three modules each had their own copy of this loop with a different
// ceiling, and at 30,000 cases all three silently truncated.

// Master tables come from the analytics snapshot too, so these pages issue no
// ZCQL from the browser at all — the whole page is a handful of blob reads.
async function mapOf(table, idCol) {
  const rows = await fetchSnapshotTable(table);
  const m = new Map();
  rows.forEach((r) => m.set(String(r[idCol]), r));
  return m;
}

const DAYPART = (h) =>
  h < 6 ? 'Night 00–06' : h < 12 ? 'Morning 06–12' : h < 18 ? 'Afternoon 12–18' : 'Evening 18–24';

// MO tokens recoverable from the FIR brief facts. Kept as readable labels so
// the UI can show *which* behaviours two crimes share.
const MO_TOKENS = [
  [/unknown persons/i, 'Unidentified offender'],
  [/online contact|fraudulently transferred/i, 'Online contact'],
  [/false promises/i, 'Lured on false promises'],
  [/accused vehicle/i, 'Vehicle involved'],
  [/involving a minor/i, 'Minor targeted'],
  [/contraband/i, 'Contraband seized'],
  [/following a dispute/i, 'Dispute escalation'],
  [/intercepted/i, 'Police interception'],
];
const PLACE_RE = /(?:\bat|\bnear) ([A-Z][A-Za-z ]+?)(?: during| following| involving| on false| and seized|\.|,)/;

// Binary behavioural feature set for one case (Jaccard operates on these).
function featuresOf(c) {
  const f = new Set();
  if (c.type !== '—') f.add(c.type);
  if (c.group && c.group !== '—') f.add(c.group);
  if (c.heinous) f.add('Heinous offence');
  if (Number.isFinite(c.hour)) f.add(DAYPART(c.hour));
  if (c.weekend) f.add('Weekend');
  MO_TOKENS.forEach(([re, label]) => { if (re.test(c.brief)) f.add(label); });
  const place = c.brief.match(PLACE_RE);
  if (place) f.add(`Locality: ${place[1].trim()}`);
  if (c.victim) {
    f.add(`Victim: ${c.victim.gender}`);
    f.add(`Victim: ${c.victim.band}`);
  }
  return f;
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  a.forEach((t) => { if (b.has(t)) inter++; });
  return inter / (a.size + b.size - inter);
}

export function sharedFeatures(a, b) {
  const out = [];
  a.forEach((t) => { if (b.has(t)) out.push(t); });
  return out;
}

const R = 6371; // km
export function haversineKm(la1, lo1, la2, lo2) {
  const rad = Math.PI / 180;
  const dLa = (la2 - la1) * rad;
  const dLo = (lo2 - lo1) * rad;
  const s =
    Math.sin(dLa / 2) ** 2 +
    Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Domain weights and decay constants. Exponential decay turns raw
// distance/day-gap into a 0–1 proximity score; the scales (~40 km, ~120 days)
// were calibrated against the dataset's ground-truth series so that linked
// pairs separate from unlinked ones (AUC ≈ 0.87 in offline validation).
export const WEIGHTS = { behaviour: 0.5, spatial: 0.3, temporal: 0.2 };
const KM_TAU = 40;
const DAY_TAU = 120;

// Score candidate `b` against index case `a` → { score, j, km, days, ... }.
export function scorePair(a, b) {
  const j = jaccard(a.features, b.features);
  const km =
    Number.isFinite(a.lat) && Number.isFinite(b.lat)
      ? haversineKm(a.lat, a.lon, b.lat, b.lon)
      : null;
  const days =
    a.ts && b.ts ? Math.abs(a.ts - b.ts) / 86400000 : null;
  const sSpatial = km == null ? 0 : Math.exp(-km / KM_TAU);
  const sTemporal = days == null ? 0 : Math.exp(-days / DAY_TAU);
  const score =
    WEIGHTS.behaviour * j + WEIGHTS.spatial * sSpatial + WEIGHTS.temporal * sTemporal;
  return { score, j, sSpatial, sTemporal, km, days };
}

/* The same arithmetic, returning only the number.
 *
 * Validation calls this 3.6 million times and reads nothing but `.score`, so
 * scorePair's breakdown object was 3.6 million allocations thrown away
 * immediately. Identical formula, identical value — this exists purely so the
 * measurement does not have to allocate to produce it. The UI still uses
 * scorePair, because the UI shows the breakdown. */
export function pairScore(a, b) {
  const j = jaccard(a.features, b.features);
  const km =
    Number.isFinite(a.lat) && Number.isFinite(b.lat)
      ? haversineKm(a.lat, a.lon, b.lat, b.lon)
      : null;
  const days = a.ts && b.ts ? Math.abs(a.ts - b.ts) / 86400000 : null;
  const sSpatial = km == null ? 0 : Math.exp(-km / KM_TAU);
  const sTemporal = days == null ? 0 : Math.exp(-days / DAY_TAU);
  return WEIGHTS.behaviour * j + WEIGHTS.spatial * sSpatial + WEIGHTS.temporal * sTemporal;
}

// AUC via the Mann-Whitney rank statistic (ties get average ranks) — the
// probability that a random linked pair outscores a random unlinked pair.
function rocAuc(linkedScores, unlinkedScores) {
  const all = [
    ...linkedScores.map((s) => ({ s, linked: 1 })),
    ...unlinkedScores.map((s) => ({ s, linked: 0 })),
  ].sort((x, y) => x.s - y.s);
  let i = 0;
  let rankSum = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].s === all[i].s) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (all[k].linked) rankSum += avgRank;
    i = j + 1;
  }
  const n1 = linkedScores.length;
  const n2 = unlinkedScores.length;
  if (!n1 || !n2) return null;
  return (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n2);
}

// Swets (1988) interpretation bands, as used across the linkage literature.
export function aucBand(auc) {
  if (auc == null) return '';
  if (auc >= 0.9) return 'high accuracy';
  if (auc >= 0.7) return 'moderate accuracy';
  if (auc >= 0.5) return 'low accuracy';
  return 'non-informative';
}

export async function fetchLinkageData() {
  const [baseCases, accused, victims, extra, units, districts, heads, subheads, statuses] =
    await Promise.all([
      fetchSnapshotTable('CaseMaster'),
      fetchSnapshotTable('Accused'),
      fetchSnapshotTable('Victim'),
      // Coordinates and BriefFacts live in their own snapshot entry: 4 MB that
      // only this tab needs, kept out of the payload every other page fetches.
      fetchSnapshotTable('CaseLinkageExtra'),
      mapOf('Unit', 'UnitID', ['UnitName', 'DistrictID']),
      mapOf('District', 'DistrictID', ['DistrictName']),
      mapOf('CrimeHead', 'CrimeHeadID', ['CrimeGroupName']),
      mapOf('CrimeSubHead', 'CrimeSubHeadID', ['CrimeHeadName']),
      mapOf('CaseStatusMaster', 'CaseStatusID', ['CaseStatusName']),
    ]);

  // Merge the linkage-only columns onto the case rows the rest of this module
  // already expects, so nothing downstream has to know they arrived separately.
  //
  // Built as NEW objects rather than written onto the snapshot rows: those rows
  // are the shared cached copy every other analytics page reads, and writing a
  // field onto them here would leak this tab's data into all of them.
  const extraByCase = new Map(extra.map((e) => [String(e.CaseMasterID), e]));
  const cases = baseCases.map((c) => {
    const e = extraByCase.get(String(c.CaseMasterID));
    return e ? { ...c, latitude: e.latitude, longitude: e.longitude, BriefFacts: e.BriefFacts } : c;
  });

  // First victim per case → target-selection features (gender + age band).
  const GENDER = { 1: 'male', 2: 'female', 3: 'transgender' };
  const victimByCase = new Map();
  victims.forEach((v) => {
    const cid = String(v.CaseMasterID);
    if (victimByCase.has(cid)) return;
    const age = Number(v.AgeYear);
    victimByCase.set(cid, {
      gender: GENDER[String(v.GenderID)] || 'unknown',
      band: !Number.isFinite(age) ? 'age unknown' : age < 18 ? 'minor' : age >= 60 ? 'senior' : 'adult',
    });
  });

  const list = [];
  cases.forEach((c) => {
    const unit = units.get(String(c.PoliceStationID));
    const district = unit ? districts.get(String(unit.DistrictID))?.DistrictName : '';
    const inc = String(c.IncidentFromDate || '');
    const hour = Number(inc.slice(11, 13));
    const d = inc ? new Date(inc.slice(0, 10)) : null;
    const statusId = String(c.CaseStatusID);
    const row = {
      id: String(c.CaseMasterID),
      crimeNo: String(c.CrimeNo || ''),
      date: inc.slice(0, 10) || String(c.CrimeRegisteredDate || '').slice(0, 10),
      ts: d && !Number.isNaN(d.getTime()) ? d.getTime() : null,
      hour: Number.isFinite(hour) ? hour : NaN,
      weekend: d ? d.getDay() === 0 || d.getDay() === 6 : false,
      station: unit?.UnitName || '—',
      district: district || '—',
      type:
        subheads.get(String(c.CrimeMinorHeadID))?.CrimeHeadName ||
        heads.get(String(c.CrimeMajorHeadID))?.CrimeGroupName ||
        '—',
      group: heads.get(String(c.CrimeMajorHeadID))?.CrimeGroupName || '—',
      status: statuses.get(statusId)?.CaseStatusName || '—',
      unsolved: statusId === '1' || statusId === '7',
      heinous: String(c.GravityOffenceID) === '1',
      lat: Number(c.latitude),
      lon: Number(c.longitude),
      brief: String(c.BriefFacts || ''),
      victim: victimByCase.get(String(c.CaseMasterID)) || null,
      offenders: new Set(),
    };
    row.features = featuresOf(row);
    list.push(row);
  });
  const byId = new Map(list.map((c) => [c.id, c]));

  // Ground truth: cases sharing a global offender PersonID are linked.
  const casesByPerson = new Map();
  accused.forEach((r) => {
    const pid = String(r.PersonID || '').trim();
    const cid = String(r.CaseMasterID);
    if (!pid || !byId.has(cid)) return;
    byId.get(cid).offenders.add(pid);
    (casesByPerson.get(pid) || casesByPerson.set(pid, new Set()).get(pid)).add(cid);
  });

  const linkedPairs = new Set(); // "a|b" with a<b
  casesByPerson.forEach((cids) => {
    const arr = [...cids];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const [a, b] = arr[i] < arr[j] ? [arr[i], arr[j]] : [arr[j], arr[i]];
        linkedPairs.add(`${a}|${b}`);
      }
    }
  });

  return { cases: list, byId, casesByPerson, linkedPairs };
}

// Validate the composite score against ground truth: ROC AUC over linked vs
// (deterministically sampled) unlinked pairs, plus the ranked-list measure the
// literature reports — how often a true linked crime appears in the top 10
// candidates for an index offence that belongs to a known series.
/* The hit-rate half of this is 120 index cases scored against every one of
 * 30,000 candidates — 3.6 million comparisons, and five seconds of unbroken
 * main-thread work at the deployed data size. Run straight from render, that
 * was five seconds in which the tab did not paint, scroll or answer a click:
 * the page did not look slow, it looked broken.
 *
 * So the body is a GENERATOR that yields between index cases. `validate` drains
 * it in one go and behaves exactly as it always did; `validateAsync` drains it
 * in ~12ms slices, handing the browser back between them, which is what the UI
 * uses. The arithmetic is identical either way — this changes when the work
 * happens, never what it computes. */
function* validateSteps(data, { pairCap = 4000, hitSample = 120 } = {}) {
  const { cases, byId, linkedPairs } = data;
  const n = cases.length;
  if (!n || !linkedPairs.size) return { auc: null, hitRate: null, linkedPairs: 0, seriesCases: 0 };

  const linkedScores = [];
  const seen = [];
  linkedPairs.forEach((key) => {
    if (linkedScores.length >= pairCap) return;
    const [a, b] = key.split('|');
    linkedScores.push(pairScore(byId.get(a), byId.get(b)));
    seen.push(key);
  });

  // Deterministic pseudo-random unlinked sample (stable across reloads).
  const unlinkedScores = [];
  let seed = 48271;
  const next = () => { seed = (seed * 16807) % 2147483647; return seed; };
  let guard = 0;
  while (unlinkedScores.length < linkedScores.length && guard++ < pairCap * 20) {
    const i = next() % n;
    const j = next() % n;
    if (i === j) continue;
    const a = cases[i];
    const b = cases[j];
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (linkedPairs.has(key)) continue;
    unlinkedScores.push(pairScore(a, b));
  }
  const auc = rocAuc(linkedScores, unlinkedScores);

  // Ranked-list hit rate over series cases.
  const seriesMates = new Map(); // caseId -> Set of true linked caseIds
  linkedPairs.forEach((key) => {
    const [a, b] = key.split('|');
    (seriesMates.get(a) || seriesMates.set(a, new Set()).get(a)).add(b);
    (seriesMates.get(b) || seriesMates.set(b, new Set()).get(b)).add(a);
  });
  const seriesCases = [...seriesMates.keys()];
  const step = Math.max(1, Math.floor(seriesCases.length / hitSample));
  let hits = 0;
  let tried = 0;
  const topN = [];   // reused across index cases; ≤10 entries
  for (let s = 0; s < seriesCases.length && tried < hitSample; s += step) {
    yield;
    const idx = byId.get(seriesCases[s]);
    const mates = seriesMates.get(idx.id);
    // Streaming top-10 instead of scoring all 30,000 into an array and
    // sorting it. Array.sort is stable, so a full sort keeps the earlier
    // candidate among equal scores; displacing only on a STRICTLY higher score
    // while scanning in the same order keeps exactly the same ten. Same answer,
    // without 60,000 throwaway objects per index case.
    for (let c = 0; c < cases.length; c++) {
      const cand = cases[c];
      if (cand.id === idx.id) continue;
      const sc = pairScore(idx, cand);
      if (topN.length < 10) {
        insertTop(topN, cand.id, sc);
      } else if (sc > topN[topN.length - 1].score) {
        topN.pop();
        insertTop(topN, cand.id, sc);
      }
    }
    if (topN.some((t) => mates.has(t.id))) hits++;
    topN.length = 0;
    tried++;
  }

  return {
    auc,
    hitRate: tried ? hits / tried : null,
    linkedPairs: linkedPairs.size,
    seriesCases: seriesCases.length,
  };
}

/* Insert into a descending top-list, AFTER every entry with a score at least
   as high — which is what a stable descending sort does with ties. */
function insertTop(list, id, score) {
  let i = list.length;
  while (i > 0 && list[i - 1].score < score) i--;
  list.splice(i, 0, { id, score });
}

const EMPTY_VALIDATION = { auc: null, hitRate: null, linkedPairs: 0, seriesCases: 0 };

/** Blocking validation. Unchanged in what it returns; used by the tests. */
export function validate(data, opts) {
  const it = validateSteps(data, opts);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value || EMPTY_VALIDATION;
}

/** The same validation, in slices, so the page keeps painting while it runs. */
export async function validateAsync(data, opts, { sliceMs = 12 } = {}) {
  const it = validateSteps(data, opts);
  let r = it.next();
  let t0 = Date.now();
  while (!r.done) {
    if (Date.now() - t0 >= sliceMs) { await breathe(); t0 = Date.now(); }
    r = it.next();
  }
  return r.value || EMPTY_VALIDATION;
}

/**
 * Is the linkage score calibrated — does 0.8 mean anything like 80%?
 *
 * validate() answers whether the model RANKS well. This answers whether its
 * numbers mean what they say, which is a different question and the one an
 * officer is actually reading. See utils/calibration.js for why the two come
 * apart.
 *
 * THE SAMPLING, WHICH IS THE ENTIRE DIFFICULTY
 *
 * Linked pairs are vanishingly rare among all pairs: with n cases there are
 * n(n-1)/2 pairs and only a few thousand are true links. Scoring all of them
 * is not possible in a browser, so we do what every case-control study does —
 * take every positive and a manageable sample of negatives — and then WEIGHT
 * each sampled pair by how many pairs of its class it stands for.
 *
 * Skip that weighting and the reliability curve comes out beautifully straight
 * against a 50/50 sample that does not exist, and every probability is
 * overstated by two orders of magnitude. The weights are what make this a
 * statement about the case file rather than about the sample.
 */
export function calibrateLinkage(data, { pairCap = 4000, negativeSample = 8000 } = {}) {
  const { cases, byId, linkedPairs } = data;
  const n = cases.length;
  if (!n || !linkedPairs || !linkedPairs.size) return null;

  const totalPairs = (n * (n - 1)) / 2;
  const linkedTotal = linkedPairs.size;
  const unlinkedTotal = totalPairs - linkedTotal;
  if (unlinkedTotal <= 0) return null;

  // Positives: every linked pair, up to the cap.
  const positives = [];
  linkedPairs.forEach((key) => {
    if (positives.length >= pairCap) return;
    const [a, b] = key.split('|');
    const ca = byId.get(a);
    const cb = byId.get(b);
    if (ca && cb) positives.push(scorePair(ca, cb).score);
  });
  if (!positives.length) return null;

  // Negatives: a deterministic pseudo-random sample, so the figure an officer
  // sees does not change between two loads of the same data. Same generator as
  // validate() uses, for the same reason.
  const negatives = [];
  let seed = 48271;
  const next = () => { seed = (seed * 16807) % 2147483647; return seed; };
  let guard = 0;
  while (negatives.length < negativeSample && guard++ < negativeSample * 20) {
    const i = next() % n;
    const j = next() % n;
    if (i === j) continue;
    const a = cases[i];
    const b = cases[j];
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (linkedPairs.has(key)) continue;
    negatives.push(scorePair(a, b).score);
  }
  if (!negatives.length) return null;

  // Each sampled pair stands for this many real pairs of its class.
  const wPos = linkedTotal / positives.length;
  const wNeg = unlinkedTotal / negatives.length;

  const samples = [
    ...positives.map((x) => ({ x, y: 1, w: wPos })),
    ...negatives.map((x) => ({ x, y: 0, w: wNeg })),
  ];

  const result = assess(samples);
  if (!result) return null;

  const baseRate = linkedTotal / totalPairs;
  return {
    ...result,
    baseRate,
    linkedPairs: linkedTotal,
    totalPairs,
    positivesScored: positives.length,
    negativesSampled: negatives.length,
  };
}

/**
 * Turn a raw similarity score into a calibrated probability, with the context
 * that makes it readable.
 *
 * The absolute number will be low, and that is the honest answer rather than a
 * disappointing one: among all pairs of cases, almost none are the same
 * offender, so even a strong candidate is unlikely in absolute terms. Reporting
 * the LIFT alongside it is what makes it useful — "thirty times more likely
 * than an arbitrary pair, and still only twelve percent" tells an officer both
 * that this is their best lead and that it is not proof.
 */
export function calibratedProbability(calibration, score) {
  if (!calibration || !Number.isFinite(score)) return null;
  const p = applyIsotonic(calibration.fit, score);
  if (p == null) return null;
  const base = calibration.baseRate || 0;
  // Support is expressed as a share of all pairs the fit was built from, so
  // "thin" means thin relative to this dataset rather than to an absolute count
  // that would mean nothing to a reader.
  const support = isotonicSupport(calibration.fit, score);
  const totalWeight = (calibration.fit || []).reduce((a, b) => a + b.weight, 0);
  return {
    probability: p,
    baseRate: base,
    lift: base > 0 ? p / base : null,
    support,
    thin: totalWeight > 0 ? support / totalWeight < 0.01 : true,
  };
}

// Rank every other case against the index offence. Returns scored candidates,
// best first, with the ground-truth flag for confirmed same-offender cases.
export function rankCandidates(data, indexId, { sameDistrict = false, unsolvedOnly = false } = {}) {
  const idx = data.byId.get(indexId);
  if (!idx) return [];
  const out = [];
  data.cases.forEach((c) => {
    if (c.id === indexId) return;
    if (sameDistrict && c.district !== idx.district) return;
    if (unsolvedOnly && !c.unsolved) return;
    const s = scorePair(idx, c);
    let confirmed = false;
    c.offenders.forEach((p) => { if (idx.offenders.has(p)) confirmed = true; });
    out.push({ case: c, ...s, confirmed, shared: sharedFeatures(idx.features, c.features) });
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

// A good default index offence for first paint: an unsolved-friendly case from
// one of the larger known series, so the ranked list demonstrates confirmed
// links immediately.
export function defaultIndexCase(data) {
  let best = null;
  let bestSize = 0;
  data.casesByPerson.forEach((cids) => {
    if (cids.size > bestSize) { bestSize = cids.size; best = cids; }
  });
  if (!best) return data.cases[0]?.id || null;
  const arr = [...best].map((id) => data.byId.get(id)).filter(Boolean);
  arr.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return arr[0]?.id || data.cases[0]?.id || null;
}


/* Case Linkage, built once per session, in two pieces on purpose.
 *
 * The coded case set and the calibration are fast; the validation is not — it
 * is 120 index cases scored against all 30,000, and it used to run inside a
 * render, freezing the tab for five seconds before anything appeared. Splitting
 * it means the page can draw the ranking immediately and fill the validation
 * KPIs in when they land, rather than making the officer wait for a metric to
 * read a candidate list.
 */
export const LINKAGE_KEY = 'caseLinkage';
export const LINKAGE_VALIDATION_KEY = 'caseLinkageValidation';

export function getLinkageData() {
  return derived(LINKAGE_KEY, async () => {
    await afterPaint();          // spinner first, then the build
    const data = await fetchLinkageData();
    return { ...data, calibration: calibrateLinkage(data) };
  });
}

/** The slow half, yielded in slices so the page keeps painting while it runs. */
export function getLinkageValidation(data) {
  return derived(LINKAGE_VALIDATION_KEY, () => validateAsync(data));
}

export function refreshLinkage() {
  invalidate(LINKAGE_KEY);
  invalidate(LINKAGE_VALIDATION_KEY);
}
