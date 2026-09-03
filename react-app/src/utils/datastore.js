// Data Store access for the Case Files browser.
//
// Reads run through ZCQL in the browser via the Catalyst Web SDK v4:
//   const zcql = window.catalyst.ZCatalystQL;
//   zcql.executeQuery('SELECT * FROM fir LIMIT 0, 50')
//     .then(resp => resp.content) // [{ fir: { ROWID, fir_id, ... } }, ...]
// Each returned row is keyed by the table name, so we flatten `row[table]`.
//
// Pagination is done with ZCQL `LIMIT offset, count`. To know whether a "Next"
// page exists without a second COUNT query, we ask for one extra row
// (perPage + 1) and trim it — robust even when COUNT is unavailable.

import { getCatalyst } from './catalyst';
import { isOnline, reportOffline, reportOnline } from './offline';

// The Police FIR schema tables in the Data Store (see ksp/fir/import/SCHEMA.md),
// grouped for the table switcher. `name` must match the table name exactly.
export const TABLE_GROUPS = [
  {
    group: 'Cases',
    tables: [
      { name: 'CaseMaster', label: 'FIRs / Cases' },
      { name: 'ChargesheetDetails', label: 'Chargesheets' },
      { name: 'ActSectionAssociation', label: 'Charged Act-Sections' },
    ],
  },
  {
    group: 'People',
    tables: [
      { name: 'ComplainantDetails', label: 'Complainants' },
      { name: 'Victim', label: 'Victims' },
      { name: 'Accused', label: 'Accused' },
      { name: 'ArrestSurrender', label: 'Arrests & Surrenders' },
      { name: 'Employee', label: 'Officers' },
    ],
  },
  {
    group: 'Crime Classification',
    tables: [
      { name: 'CrimeHead', label: 'Crime Heads' },
      { name: 'CrimeSubHead', label: 'Crime Sub-Heads' },
      { name: 'CrimeHeadActSection', label: 'Head ↔ Act-Section Map' },
      { name: 'Act', label: 'Acts' },
      { name: 'Section', label: 'Sections' },
    ],
  },
  {
    group: 'Geography & Units',
    tables: [
      { name: 'Unit', label: 'Police Stations / Units' },
      { name: 'District', label: 'Districts' },
      { name: 'State', label: 'States' },
      { name: 'Court', label: 'Courts' },
      { name: 'UnitType', label: 'Unit Types' },
    ],
  },
  {
    group: 'Lookups',
    tables: [
      { name: 'CaseCategory', label: 'Case Categories' },
      { name: 'CaseStatusMaster', label: 'Case Statuses' },
      { name: 'GravityOffence', label: 'Gravity Levels' },
      { name: 'Rank', label: 'Ranks' },
      { name: 'Designation', label: 'Designations' },
      { name: 'ReligionMaster', label: 'Religions' },
      { name: 'CasteMaster', label: 'Castes' },
      { name: 'OccupationMaster', label: 'Occupations' },
    ],
  },
];

export const ALL_TABLES = TABLE_GROUPS.flatMap((g) => g.tables);
export const tableLabel = (name) =>
  ALL_TABLES.find((t) => t.name === name)?.label || name;

// Catalyst-managed columns. ROWID is kept (useful primary key); the audit
// columns are hidden by default behind a toggle.
export const SYSTEM_COLUMNS = ['CREATORID', 'CREATEDTIME', 'MODIFIEDTIME'];

function zcql() {
  const cat = getCatalyst();
  const q = cat && cat.ZCatalystQL;
  if (!q || typeof q.executeQuery !== 'function') {
    throw new Error(
      'Data Store is unavailable — the Catalyst SDK is not loaded. ' +
        'Open the app from its deployed Catalyst URL while signed in.'
    );
  }
  return q;
}

// Escape single quotes for safe embedding in a ZCQL string literal.
const escLiteral = (s) => String(s).replace(/'/g, "''");

// Normalise executeQuery's response into a flat array of row objects.
// The SDK returns either an array or `{ content: [...] }`; some responses put a
// non-array under `content`, so guard against anything that isn't an array.
function flatten(resp, table) {
  const rows = Array.isArray(resp)
    ? resp
    : Array.isArray(resp && resp.content)
    ? resp.content
    : [];
  return rows.map((r) => {
    if (r && typeof r === 'object') {
      if (r[table] && typeof r[table] === 'object') return r[table];
      const keys = Object.keys(r);
      if (keys.length === 1 && r[keys[0]] && typeof r[keys[0]] === 'object') {
        return r[keys[0]];
      }
    }
    return r;
  });
}

// Supported filter operators (also the value list the UI renders).
export const FILTER_OPS = [
  { value: 'contains', label: 'contains' },
  { value: '=', label: 'equals (=)' },
  { value: '!=', label: 'not equals (≠)' },
  { value: '>', label: 'greater than (>)' },
  { value: '>=', label: 'at least (≥)' },
  { value: '<', label: 'less than (<)' },
  { value: '<=', label: 'at most (≤)' },
  { value: 'starts', label: 'starts with' },
  { value: 'ends', label: 'ends with' },
];
const CMP_OPS = new Set(['>', '>=', '<', '<=']);

// Type-aware WHERE clause with an operator. ZCQL's LIKE is case-sensitive and
// doesn't apply to numeric columns, so numeric columns use direct comparison
// (the sampled value detects the type) while text columns OR together common
// capitalisation variants for a case-insensitive feel.
const NUM_RE = /^-?\d+(\.\d+)?$/;
function buildWhere(column, search, sampleValue, op = 'contains') {
  const q = (search || '').trim();
  if (!q || !column || column === 'ALL') return '';

  const sample = sampleValue == null ? '' : String(sampleValue);
  const numericColumn = typeof sampleValue === 'number' || (sample !== '' && NUM_RE.test(sample));

  if (numericColumn) {
    // A non-numeric query can't match a numeric column → sentinel = no rows.
    if (!NUM_RE.test(q)) return ` WHERE ${column} = -987654321`;
    // LIKE-style ops on a number fall back to equality (LIKE is invalid there).
    const numOp = CMP_OPS.has(op) || op === '=' || op === '!=' ? op : '=';
    return ` WHERE ${column} ${numOp} ${q}`;
  }

  // Text column.
  if (CMP_OPS.has(op)) return ` WHERE ${column} ${op} '${escLiteral(q)}'`;

  const title = q.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  const variants = [...new Set([q, q.toLowerCase(), q.toUpperCase(), title])];
  if (op === '=') return ' WHERE ' + variants.map((v) => `${column} = '${escLiteral(v)}'`).join(' OR ');
  if (op === '!=') return ' WHERE ' + variants.map((v) => `${column} != '${escLiteral(v)}'`).join(' AND ');

  const pat = op === 'starts' ? (v) => `${escLiteral(v)}%`
    : op === 'ends' ? (v) => `%${escLiteral(v)}`
    : (v) => `%${escLiteral(v)}%`;
  return ' WHERE ' + variants.map((v) => `${column} LIKE '${pat(v)}'`).join(' OR ');
}

// Run an arbitrary ZCQL query and return flattened row objects. Used by the
// Reports page for GROUP BY / aggregate queries. `table` is the FROM table name
// (needed to un-nest the table-keyed response rows).
// Every screen that reads case data comes through here, so this is the one
// place worth making a lost connection legible. Offline these queries cannot
// succeed — the Data Store is deliberately never cached, because caching it
// would put FIR records on the officer's disk — so the honest thing is to say
// so in a sentence an officer can act on, rather than surface an SDK error.
export const OFFLINE_MESSAGE =
  'No connection — case records need the network. The crime map, station '
  + 'directory and org chart still work offline, and anything you add to an '
  + 'open case is saved on this device and synced when you are back online.';

export async function runQuery(sql, table) {
  if (!isOnline()) throw new Error(OFFLINE_MESSAGE);
  try {
    const resp = await zcql().executeQuery(sql);
    reportOnline();
    return flatten(resp, table);
  } catch (e) {
    // navigator.onLine only reports whether an interface is up: a station on a
    // dead uplink claims to be online and every request still fails. A failed
    // request is the more reliable signal, so it updates the shared state that
    // drives the status bar.
    if (e instanceof TypeError || !navigator.onLine) {
      reportOffline();
      throw new Error(OFFLINE_MESSAGE);
    }
    throw e;
  }
}

// Fetch the column list for a table plus one sample row (used to infer the
// column types when filtering). Returns { columns: [], sample: {} } if empty.
export async function fetchColumns(table) {
  const resp = await zcql().executeQuery(`SELECT * FROM ${table} LIMIT 0, 1`);
  const rows = flatten(resp, table);
  return {
    columns: rows.length ? Object.keys(rows[0]) : [],
    sample: rows[0] || {},
  };
}

// Fetch one page. Returns { rows, hasNext }. Asks for perPage+1 to detect a
// following page without a COUNT query.
export async function fetchPage({ table, page = 1, perPage = 50, column = 'ALL', search = '', op = 'contains', sample }) {
  const offset = (page - 1) * perPage;
  const where = buildWhere(column, search, sample?.[column], op);
  const query = `SELECT * FROM ${table}${where} LIMIT ${offset}, ${perPage + 1}`;
  const resp = await zcql().executeQuery(query);
  const rows = flatten(resp, table);
  const hasNext = rows.length > perPage;
  return { rows: hasNext ? rows.slice(0, perPage) : rows, hasNext };
}

// Fetch every row of a table (paginated at the ZCQL per-query cap). Used by
// the Excel export; `cap` is a safety limit per table.

/* ── The analytics read cache ────────────────────────────────────────────────
 *
 * Every analytics page — the home bento, all five AI Analytics tabs, Custody,
 * Crime Links — reads the SAME handful of tables in full and derives different
 * things from them. Each was re-reading all 30,000 cases from scratch on every
 * mount, so moving between two tabs cost two full table scans and the page sat
 * on a spinner for ten to fifteen seconds each time.
 *
 * The FIR data is read-only in this product: nothing in the app writes to
 * CaseMaster, Accused or Unit. A read is therefore safe to reuse, and the only
 * question is for how long.
 *
 * `inflight` is the half that matters most for tab-switching. Two components
 * mounting at once used to issue two identical scans; now the second waits on
 * the first instead of doubling the load.
 */
const CACHE_TTL_MS = 15 * 60 * 1000;
const queryCache = new Map();   // key -> { at, rows }
const inflight = new Map();     // key -> Promise<rows>

export function clearQueryCache() {
  queryCache.clear();
  inflight.clear();
}

/**
 * Page a query to the end, or to a stated bound — and SAY which.
 *
 * Three analytics modules each grew their own copy of this loop with a
 * different ceiling: 6,000 rows in aianalytics, 10,000 in fetchAllRows, 30,000
 * in crimelinks. At 2,200 cases none of them ever bit. At 30,000 all three do,
 * and they did it silently: the charts were drawn from a fifth of the data and
 * captioned as though they were the whole of it.
 *
 * A truncated read is not a smaller answer, it is a different one. So the
 * result carries `truncated` and `cap`, and the caller is expected to say so on
 * screen rather than quietly present a partial figure as a total.
 *
 * Pages are fetched CONCURRENTLY. 30,000 rows at 300 a page is 100 round
 * trips; run one after another at ~100ms each that is ten seconds of waiting
 * for data the server was ready to hand over all at once.
 *
 * CALLERS MUST TREAT THE RESULT AS IMMUTABLE. It is shared with every other
 * caller of the same query, so sorting it in place or writing a field onto a
 * row would silently reorder or corrupt another page's data. Derive with map
 * and build new objects; never assign onto a returned row.
 */
export async function pageQuery(baseSql, table, {
  cap = 60000, page = 300, concurrency = 8, cache = true,
} = {}) {
  const key = `${table}|${baseSql}|${cap}|${page}`;

  if (cache) {
    const hit = queryCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const run = (async () => {
    const rows = [];
    let truncated = false;
    let done = false;

    for (let start = 0; start < cap && !done; start += page * concurrency) {
      const offsets = [];
      for (let i = 0; i < concurrency; i += 1) {
        const off = start + i * page;
        if (off >= cap) break;
        offsets.push(off);
      }
      // eslint-disable-next-line no-await-in-loop
      const batch = await Promise.all(
        offsets.map((off) => runQuery(`${baseSql} LIMIT ${off}, ${page}`, table))
      );
      for (const got of batch) {
        rows.push(...got);
        // A short page is the end of the table. Later pages in this same batch
        // are past it and are discarded rather than appended, which is why the
        // loop stops here instead of finishing the batch.
        if (got.length < page) { done = true; break; }
      }
      if (!done && start + page * concurrency >= cap) truncated = true;
    }
    return Object.assign(rows, { truncated, cap });
  })();

  if (!cache) return run;

  inflight.set(key, run);
  try {
    const rows = await run;
    queryCache.set(key, { at: Date.now(), rows });
    return rows;
  } finally {
    inflight.delete(key);
  }
}

/* ── Shared analytics reads ──────────────────────────────────────────────────
 *
 * Six modules — the home bento, four AI Analytics tabs and the custody
 * registry — each scanned CaseMaster and Accused with a slightly different
 * column list. Different SQL means a different cache key, so every tab paid
 * for its own full scan of the same 30,000 rows and the cache never helped
 * across them.
 *
 * These two queries are the UNION of what those callers ask for, so the first
 * tab to load warms all the others. Extra columns cost little; a second scan
 * of the whole table costs seconds.
 *
 * BriefFacts is deliberately absent. Only case linkage needs it, and it is
 * free text on every one of 30,000 rows — carrying it here would make five
 * pages pay for one page's feature. That module keeps its own query.
 */
export const CASE_COLUMNS = 'CaseMasterID, CrimeNo, CrimeRegisteredDate, '
  + 'IncidentFromDate, PoliceStationID, CrimeMajorHeadID, CrimeMinorHeadID, '
  + 'CaseStatusID, GravityOffenceID, CaseCategoryID, PolicePersonID, CourtID';
export const ACCUSED_COLUMNS = 'AccusedMasterID, CaseMasterID, PersonID, '
  + 'AccusedName, AgeYear, GenderID';

export const fetchSharedCases = () =>
  pageQuery(`SELECT ${CASE_COLUMNS} FROM CaseMaster`, 'CaseMaster', { cap: 60000 });
export const fetchSharedAccused = () =>
  pageQuery(`SELECT ${ACCUSED_COLUMNS} FROM Accused`, 'Accused', { cap: 60000 });

export async function fetchAllRows(table, { cap = 10000 } = {}) {
  const out = [];
  const page = 300;
  for (let offset = 0; offset < cap; offset += page) {
    const resp = await zcql().executeQuery(`SELECT * FROM ${table} LIMIT ${offset}, ${page}`);
    const rows = flatten(resp, table);
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

// Best-effort total row count (drives the "N records" label). Returns null on
// failure so the UI can still paginate via hasNext.
export async function fetchCount({ table, column = 'ALL', search = '', op = 'contains', sample }) {
  try {
    const where = buildWhere(column, search, sample?.[column], op);
    const resp = await zcql().executeQuery(`SELECT COUNT(ROWID) AS cnt FROM ${table}${where}`);
    const rows = flatten(resp, table);
    const r = rows[0] || {};
    const val = r.cnt ?? r.CNT ?? r['COUNT(ROWID)'] ?? Object.values(r)[0];
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
