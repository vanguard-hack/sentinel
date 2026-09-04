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

  /* Small reference tables. They are a single query each, but they must be
     HERE: a page asking for a table the snapshot does not know gets a 400 and
     renders nothing, which is exactly how the home page broke when
     CaseCategory was dropped from this list. analytics.test.js now asserts the
     list covers everything the client asks for. */
  CaseCategory: ['CaseCategoryID', 'LookupValue'],
  Act: ['ActCode', 'ActDescription', 'ShortName'],
  Section: ['ActCode', 'SectionCode', 'SectionDescription'],
  Rank: ['RankID', 'RankName', 'Hierarchy'],
  Designation: ['DesignationID', 'DesignationName'],
  OccupationMaster: ['OccupationID', 'OccupationName'],
  ReligionMaster: ['ReligionID', 'ReligionName'],
  CasteMaster: ['caste_master_id', 'caste_master_name'],

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

/* Which app roles may read a table, where the answer is not "anyone signed in".
 *
 * Most of these tables feed the home page, and Home is open to every role, so
 * gating them would be theatre — the same officer can already see the data on
 * a page they are entitled to open.
 *
 * CaseLinkageExtra is the exception and the reason this map exists. It carries
 * BriefFacts, the free-text narrative of all 30,000 cases, and it exists only
 * for Case Linkage — which lives under AI Analytics, a page INVESTIGATORS
 * cannot open. Serving it to any authenticated caller would hand an
 * investigator, in one request, the contents of a page the role system says
 * they may not see. The route sits behind the session gate, so this is
 * authorisation, not authentication.
 */
const TABLE_ROLES = {
  CaseLinkageExtra: ['admin', 'supervisor', 'analyst', 'policymaker'],
};

const rolesFor = (key) => TABLE_ROLES[key] || null;

const PAGE = 300;

/* ZCQL wraps every row under its table name. */
const unwrap = (row, table) => (row && row[table] ? row[table] : row);

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const causeOf = (e) => (e && (e.message || e.description || e.code)) || String(e);

/* Concurrent page reads, and what goes wrong with them.
 *
 * A snapshot build is the heaviest thing this function does to the Data Store:
 * ArrestSurrender alone is 96 queries, and a cold home page starts a build for
 * eight tables at once. Fired at full width that is ~100 queries in flight
 * against a Development datastore, and some of them come back refused —
 * throttled, or the connection dropped. There is nothing wrong with the query;
 * the same offset succeeds a moment later.
 *
 * The first version treated a refused page as fatal, which is right in the
 * sense that a silently short table is worse than an error, and wrong in that
 * one unlucky page threw away the other 95 and left the home page showing
 * "page read failed" with a Retry button. Both are avoidable: RETRY the page,
 * with a widening backoff so a throttled store is given room rather than hit
 * harder, and only give up — loudly, with the real reason attached — once a
 * page has genuinely failed several times over.
 *
 * WAVE is the width. It is not a throughput dial: 8 concurrent already runs a
 * table in a dozen round trips, and pushing it higher mostly buys more
 * throttling, which the retries then have to pay for. */
const WAVE = 8;
const RETRIES = 4;

/* Retrying has to be bounded in TIME as well as in tries, because the two run
   out differently. A badly throttled table could spend four backoffs on every
   one of a dozen waves and still be reading when the function's own clock
   stops it — and a killed invocation tells the browser nothing at all. Giving
   up first, with a reason, is strictly better: the client retries the build a
   few seconds later against a store that has had a moment to breathe. */
const BUDGET_MS = 25000;

async function readPage(app, table, select, off, deadline) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      /* eslint-disable no-await-in-loop */
      return await app.zcql()
        .executeZCQLQuery(`SELECT ${select} FROM ${table} LIMIT ${off}, ${PAGE}`);
    } catch (e) {
      last = e;
      if (attempt >= RETRIES || Date.now() > deadline) break;
      // Jittered, so eight pages refused in the same wave do not all come back
      // at the same instant and refuse each other again.
      await sleep(200 * 2 ** attempt + Math.floor(Math.random() * 250));
      /* eslint-enable no-await-in-loop */
    }
  }
  // Carry the store's own words. The previous message said only "page read
  // failed", which is how a throttle and a dropped column looked identical.
  throw new Error(`${table} rows ${off}-${off + PAGE} after ${RETRIES + 1} tries: ${causeOf(last)}`);
}

/* Read one table to the end.
 *
 * Pages are issued in waves rather than one after another. Inside the
 * datacentre a query is fast but not free, and 96 of them in series is still
 * seconds; eight at a time turns that into a dozen waves. */
async function readTable(app, table, cols, { wave = WAVE, cap = 120000, budgetMs = BUDGET_MS } = {}) {
  const out = [];
  const select = cols.join(', ');
  const deadline = Date.now() + budgetMs;
  let done = false;

  for (let start = 0; start < cap && !done; start += PAGE * wave) {
    const offsets = [];
    for (let i = 0; i < wave; i += 1) {
      const off = start + i * PAGE;
      if (off < cap) offsets.push(off);
    }
    /* eslint-disable no-await-in-loop */
    const pages = await Promise.all(offsets.map((off) => readPage(app, table, select, off, deadline)));
    /* eslint-enable no-await-in-loop */

    for (const page of pages) {
      for (const r of page) {
        const row = unwrap(r, table);
        out.push(cols.map((c) => (row[c] === undefined || row[c] === null ? null : row[c])));
      }
      // A short page is the end of the table. Later pages in this wave are past
      // it, so they are dropped rather than appended.
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

module.exports = {
  SNAPSHOT_VERSION, SNAPSHOT_KEY, TABLES, TABLE_ROLES,
  specOf, rolesFor, buildTable, readTable, readPage, WAVE, RETRIES, BUDGET_MS,
};
