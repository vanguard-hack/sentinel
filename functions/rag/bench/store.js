'use strict';

/*
 * The benchmark's ground truth.
 *
 * WHY THIS FILE EXISTS
 *
 * A benchmark whose expected answers are typed into the test file starts lying
 * the day the data changes. Reseed the Data Store and "Yelahanka has 14
 * chain-snatchings" quietly becomes false while the suite still reports green —
 * the worst possible failure for a document whose whole purpose is to be
 * trusted.
 *
 * So nothing here is hardcoded. This reads the generator's own CaseMaster.csv —
 * the exact rows that get imported into the Data Store — and answers questions
 * about it directly. Re-run the generator and every expected value moves with
 * it.
 *
 * WHY THE CSV AND NOT AN EXPORT
 *
 * It used to parse a text export snapshotted out of the Data Store by hand.
 * That was one more artefact to keep in step, it had no script that produced
 * it, and at 30,000 cases it would have been a 22MB file committed to the repo
 * for no reason. The CSV is the source those rows come from; reading it removes
 * the copy rather than growing it.
 */

const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', '..', '..', 'ksp', 'fir', 'CaseMaster.csv');
const MASTERS = require('../masters.json');

let CACHE = null;

/** Minimal RFC-4180 reader: quoted fields, embedded commas and doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parse() {
  if (CACHE) return CACHE;
  if (!fs.existsSync(CSV_PATH)) {
    CACHE = { rows: [], missing: true };
    return CACHE;
  }
  const table = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  const header = table.shift() || [];
  const at = Object.fromEntries(header.map((h, i) => [h, i]));

  const unitName = (id) => (MASTERS.units[id] || {}).name || String(id);
  const districtOf = (id) => MASTERS.districts[(MASTERS.units[id] || {}).district] || '';

  const rows = [];
  for (const r of table) {
    if (!r || r.length < header.length || !r[at.CaseMasterID]) continue;
    const station = r[at.PoliceStationID];
    const registeredDate = r[at.CrimeRegisteredDate] || '';
    const lat = Number(r[at.latitude]);
    const lon = Number(r[at.longitude]);
    rows.push({
      caseMasterId: r[at.CaseMasterID],
      crimeNo: r[at.CrimeNo],
      caseNo: r[at.CaseNo],
      registeredDate,
      station: unitName(station),
      stationId: station,
      district: districtOf(station),
      category: MASTERS.categories[r[at.CaseCategoryID]] || '',
      gravity: MASTERS.gravity[r[at.GravityOffenceID]] || '',
      crimeHead: MASTERS.crimeHeads[r[at.CrimeMajorHeadID]] || '',
      crimeSubHead: MASTERS.crimeSubHeads[r[at.CrimeMinorHeadID]] || '',
      status: MASTERS.statuses[r[at.CaseStatusID]] || '',
      court: MASTERS.courts[r[at.CourtID]] || '',
      io: (MASTERS.employees || {})[r[at.PolicePersonID]] || '',
      incidentWindow: `${r[at.IncidentFromDate]} to ${r[at.IncidentToDate]}`,
      infoReceived: r[at.InfoReceivedPSDate],
      briefFacts: r[at.BriefFacts] || '',
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lon) ? lon : null,
      year: Number(String(registeredDate).slice(0, 4)) || null,
      month: String(registeredDate).slice(0, 7) || null,
    });
  }
  CACHE = { rows, missing: false };
  return CACHE;
}

const all = () => parse().rows;
const available = () => !parse().missing && parse().rows.length > 0;

/** Rows matching every supplied field. Undefined filters are ignored. */
function find(filter = {}) {
  return all().filter((r) =>
    Object.entries(filter).every(([k, v]) => {
      if (v === undefined || v === null) return true;
      if (typeof v === 'function') return v(r[k], r);
      return String(r[k]) === String(v);
    })
  );
}

const count = (filter) => find(filter).length;

/** Distinct values of a column, most frequent first. */
function distinct(field) {
  const seen = new Map();
  for (const r of all()) {
    const v = r[field];
    if (v === undefined || v === null || v === '') continue;
    seen.set(v, (seen.get(v) || 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }));
}

/**
 * A district / crime-head pair with no records at all.
 *
 * This is the planted gap the abstention checks fire at, and it is FOUND
 * rather than chosen: a hand-picked gap ("no narcotics in Kalaburagi") becomes
 * wrong the moment someone seeds one narcotics case there, and the check would
 * then be testing nothing while still passing. Recomputing it means the gap is
 * a gap on the day the benchmark runs.
 *
 * Districts and heads are drawn from the busiest values so the question still
 * sounds like one an officer would plausibly ask.
 */
function emptyPair() {
  // Every combination, not the busiest few.
  //
  // This searched the top twelve districts against the top twelve crime types,
  // which found a gap easily at 2,200 cases and found nothing at 30,000 — the
  // popular combinations are all populated at that size, and the abstention
  // check silently had nothing to fire at. The gap that does exist is
  // deliberate (see NO_DATA_GAP in the generator) and sits at rank 12 and rank
  // 31, so it is only found by sweeping the lot.
  //
  // Counted from an index rather than by re-filtering 961 times, because the
  // naive version was 961 passes over 30,000 rows.
  const seen = new Set();
  for (const r of all()) {
    if (r.district && r.crimeSubHead) seen.add(`${r.district}\u0000${r.crimeSubHead}`);
  }
  for (const { value: district } of distinct('district')) {
    for (const { value: crimeSubHead } of distinct('crimeSubHead')) {
      if (!seen.has(`${district}\u0000${crimeSubHead}`)) return { district, crimeSubHead };
    }
  }
  return null;
}

/** A district / crime-head pair that definitely has records, with its count. */
function populatedPair() {
  const heads = distinct('crimeSubHead').slice(0, 8).map((h) => h.value);
  for (const { value: district } of distinct('district').slice(0, 8)) {
    for (const crimeSubHead of heads) {
      const n = count({ district, crimeSubHead });
      if (n >= 3) return { district, crimeSubHead, n };
    }
  }
  return null;
}

function stats() {
  const rows = all();
  const dates = rows.map((r) => r.registeredDate).filter(Boolean).sort();
  return {
    rows: rows.length,
    districts: distinct('district').length,
    crimeHeads: distinct('crimeHead').length,
    crimeSubHeads: distinct('crimeSubHead').length,
    from: dates[0] || null,
    to: dates[dates.length - 1] || null,
  };
}

module.exports = { CSV_PATH, all, available, find, count, distinct, emptyPair, populatedPair, stats };
