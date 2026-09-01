'use strict';

/*
 * The benchmark's ground truth.
 *
 * WHY THIS FILE EXISTS
 *
 * A benchmark whose expected answers are typed into the test file is a
 * benchmark that starts lying the day the data changes. Reseed the Data Store,
 * and "Yelahanka has 14 chain-snatchings" quietly becomes false while the
 * suite still reports green — the worst possible failure for a document whose
 * whole purpose is to be trusted.
 *
 * So nothing here is hardcoded. This module parses the exported snapshot of
 * CaseMaster and answers questions about it directly: how many FIRs match a
 * filter, which district/crime-head pairs have no records at all, what the
 * real Brief Facts prose looks like. The harness asks the store what is true,
 * asks Sentinel the same question, and compares. Re-export the data and every
 * expected value moves with it.
 *
 * The snapshot is the same 2,200 rows that were imported into the Data Store,
 * so a count computed here is the count the live table would return.
 */

const fs = require('fs');
const path = require('path');

const EXPORT_PATH = path.join(__dirname, '..', '..', '..', 'datastore_export', 'FIR_data_recent_first.txt');

// Each record is a block of `Label : value` lines under a `--- FIR n ---`
// header. The labels are padded to a fixed width in the export, hence the
// loose separator match.
const FIELD_MAP = {
  'Registered Date': 'registeredDate',
  'Case No': 'caseNo',
  'Police Station': 'station',
  District: 'district',
  Category: 'category',
  Gravity: 'gravity',
  'Crime Head': 'crimeHeadRaw',
  Status: 'status',
  Court: 'court',
  'Investigating O.': 'io',
  'Incident Window': 'incidentWindow',
  'Info Recv at PS': 'infoReceived',
  Location: 'location',
  'Brief Facts': 'briefFacts',
};

let CACHE = null;

function parse() {
  if (CACHE) return CACHE;
  if (!fs.existsSync(EXPORT_PATH)) {
    CACHE = { rows: [], missing: true };
    return CACHE;
  }
  const text = fs.readFileSync(EXPORT_PATH, 'utf8');
  const blocks = text.split(/\n--- FIR \d+\s+\(CrimeNo (\d+)\) ---\n/);

  const rows = [];
  // split() yields [preamble, crimeNo, body, crimeNo, body, ...]
  for (let i = 1; i < blocks.length; i += 2) {
    const crimeNo = blocks[i];
    const body = blocks[i + 1] || '';
    const rec = { crimeNo };
    for (const line of body.split('\n')) {
      const m = /^([A-Za-z. ]+?)\s*:\s(.*)$/.exec(line);
      if (!m) continue;
      const key = FIELD_MAP[m[1].trim()];
      if (key) rec[key] = m[2].trim();
    }
    if (!rec.district) continue;

    // Derived fields, so callers filter on the same shape the app uses.
    const [head, sub] = String(rec.crimeHeadRaw || '').split(' / ');
    rec.crimeHead = (head || '').trim();
    rec.crimeSubHead = (sub || '').trim();
    rec.year = Number(String(rec.registeredDate || '').slice(0, 4)) || null;
    rec.month = String(rec.registeredDate || '').slice(0, 7) || null;
    const loc = /lat\s+(-?[\d.]+),\s*lon\s+(-?[\d.]+)/.exec(rec.location || '');
    rec.latitude = loc ? Number(loc[1]) : null;
    rec.longitude = loc ? Number(loc[2]) : null;

    const idm = /\[CaseMasterID (\d+) \| ROWID (\d+)\]/.exec(body);
    if (idm) { rec.caseMasterId = idm[1]; rec.rowid = idm[2]; }
    rows.push(rec);
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
  const districts = distinct('district').slice(0, 12).map((d) => d.value);
  const heads = distinct('crimeSubHead').slice(0, 12).map((h) => h.value);
  for (const district of districts) {
    for (const crimeSubHead of heads) {
      if (count({ district, crimeSubHead }) === 0) return { district, crimeSubHead };
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

module.exports = { EXPORT_PATH, all, available, find, count, distinct, emptyPair, populatedPair, stats };
