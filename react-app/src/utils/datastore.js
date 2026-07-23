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
export async function runQuery(sql, table) {
  const resp = await zcql().executeQuery(sql);
  return flatten(resp, table);
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
