/* One request instead of four hundred.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE
 *
 * Every analytics surface — the home bento, all five AI Analytics tabs, the
 * inmate registry — reads whole tables and derives its charts in the browser.
 * ZCQL returns at most 300 rows per query, so the home page alone was:
 *
 *   CaseMaster       30,000 rows  ->  101 requests
 *   Accused          44,237 rows  ->  148 requests
 *   Victim           27,572 rows  ->   92 requests
 *   ArrestSurrender  28,708 rows  ->   96 requests
 *                                 ->  437 round trips from a browser
 *
 * Caching those responses and running them eight at a time helped a repeat
 * visit and did nothing for the first one: 437 requests is ten to fifteen
 * seconds no matter how they are batched. The fix is not to make the paging
 * faster, it is to stop paging from the browser at all.
 *
 * WHAT THIS DOES INSTEAD
 *
 * The same reads run HERE, inside the datacentre, where a round trip is a
 * fraction of a browser's. The result is encoded COLUMNAR — one array of
 * column names plus an array of value-arrays — which drops the repeated JSON
 * keys that made the payload three times larger than the data in it. The
 * assembled snapshot is then written to Stratus, so only the first caller
 * after a deploy pays to build it and everyone else gets a single blob read.
 *
 * The FIR data is read-only in this product: nothing writes to CaseMaster,
 * Accused, Victim or ArrestSurrender. A snapshot is therefore never stale
 * against a write, only against a re-import, which is what SNAPSHOT_VERSION
 * is for — bump it and every client rebuilds.
 */

const SNAPSHOT_VERSION = 2;
// Cached PER TABLE. One 11 MB response for everything risks whatever the
// function's response ceiling is, and makes a page wait for tables it does not
// use; eight parallel requests of 1-4 MB each do neither, and let the
// crime-links tab skip the five tables only the home page reads.
const SNAPSHOT_KEY = (table) => `analytics/v${SNAPSHOT_VERSION}/${table}.json`;

/* The tables the analytics pages read in full, and the columns they actually
   use. Anything not listed here is not shipped — BriefFacts alone would have
   doubled the payload for one page's benefit. */
const TABLES = {
  CaseMaster: ['CaseMasterID', 'CrimeNo', 'CrimeRegisteredDate', 'IncidentFromDate',
    'PoliceStationID', 'CrimeMajorHeadID', 'CrimeMinorHeadID', 'CaseStatusID',
    'GravityOffenceID', 'CaseCategoryID', 'PolicePersonID', 'CourtID'],
  Accused: ['AccusedMasterID', 'CaseMasterID', 'PersonID', 'AccusedName',
    'AgeYear', 'GenderID'],
  Victim: ['CaseMasterID', 'AgeYear', 'GenderID', 'VictimPolice'],
  ArrestSurrender: ['CaseMasterID', 'AccusedMasterID', 'ArrestSurrenderTypeID',
    'ArrestSurrenderDate'],
  Unit: ['UnitID', 'UnitName', 'DistrictID'],
  District: ['DistrictID', 'DistrictName'],
  CrimeHead: ['CrimeHeadID', 'CrimeGroupName'],
  CrimeSubHead: ['CrimeSubHeadID', 'CrimeHeadName', 'CrimeHeadID'],
  CaseStatusMaster: ['CaseStatusID', 'CaseStatusName'],
  Court: ['CourtID', 'CourtName'],
  ChargesheetDetails: ['CaseMasterID', 'csdate'],
  ActSectionAssociation: ['CaseMasterID', 'ActID', 'SectionID'],
  ComplainantDetails: ['CaseMasterID', 'AgeYear', 'GenderID', 'OccupationID'],
  Employee: ['EmployeeID', 'FirstName', 'RankID', 'UnitID'],

  /* Case linkage needs three more CaseMaster columns that nothing else does:
     the coordinates it measures geographic proximity with, and the free-text
     BriefFacts its modus-operandi matching reads. BriefFacts alone is 4 MB
     across 30,000 rows, so it is a SEPARATE entry keyed off the same table —
     only the linkage tab pays for it, and the other six pages do not. */
  CaseLinkageExtra: { from: 'CaseMaster',
    cols: ['CaseMasterID', 'latitude', 'longitude', 'BriefFacts'] },
};

// An entry is either a plain column list, or { from, cols } when the snapshot
// key and the underlying table name differ.
const specOf = (key) => {
  const e = TABLES[key];
  if (!e) return null;
  return Array.isArray(e) ? { from: key, cols: e } : { from: e.from, cols: e.cols };
};

const PAGE = 300;

/* ZCQL wraps every row under its table name. */
const unwrap = (row, table) => (row && row[table] ? row[table] : row);

/* Read one table to the end.
 *
 * Pages are issued in waves rather than one after another. Inside the
 * datacentre a query is fast but not free, and 148 of them in series is still
 * seconds; twelve at a time turns that into a dozen waves. */
async function readTable(app, table, cols, { wave = 12, cap = 120000 } = {}) {
  const out = [];
  const select = cols.join(', ');
  let done = false;

  for (let start = 0; start < cap && !done; start += PAGE * wave) {
    const offsets = [];
    for (let i = 0; i < wave; i += 1) {
      const off = start + i * PAGE;
      if (off < cap) offsets.push(off);
    }
    /* eslint-disable no-await-in-loop */
    const pages = await Promise.all(offsets.map((off) => app.zcql()
      .executeZCQLQuery(`SELECT ${select} FROM ${table} LIMIT ${off}, ${PAGE}`)
      .catch(() => null)));
    /* eslint-enable no-await-in-loop */

    for (const page of pages) {
      // A failed page is not an empty one. Treating it as the end of the table
      // would silently truncate the snapshot and every chart drawn from it.
      if (page === null) throw new Error(`${table}: page read failed`);
      for (const r of page) {
        const row = unwrap(r, table);
        out.push(cols.map((c) => (row[c] === undefined || row[c] === null ? null : row[c])));
      }
      if (page.length < PAGE) { done = true; break; }
    }
  }
  return out;
}

/* Build one table's snapshot. */
async function buildTable(app, key) {
  const spec = specOf(key);
  if (!spec) throw new Error(`unknown table: ${key}`);
  const { from, cols } = spec;
  const started = Date.now();
  const rows = await readTable(app, from, cols);
  return {
    version: SNAPSHOT_VERSION,
    table: key,
    built_at: new Date().toISOString(),
    build_ms: Date.now() - started,
    count: rows.length,
    cols,
    rows,
  };
}

module.exports = { SNAPSHOT_VERSION, SNAPSHOT_KEY, TABLES, specOf, buildTable, readTable };
