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

function buildWhere(column, search) {
  const q = (search || '').trim();
  if (!q || !column || column === 'ALL') return '';
  return ` WHERE ${column} LIKE '%${escLiteral(q)}%'`;
}

// Run an arbitrary ZCQL query and return flattened row objects. Used by the
// Reports page for GROUP BY / aggregate queries. `table` is the FROM table name
// (needed to un-nest the table-keyed response rows).
export async function runQuery(sql, table) {
  const resp = await zcql().executeQuery(sql);
  return flatten(resp, table);
}

// Fetch the column list for a table (from one sample row). Returns [] if empty.
export async function fetchColumns(table) {
  const resp = await zcql().executeQuery(`SELECT * FROM ${table} LIMIT 0, 1`);
  const rows = flatten(resp, table);
  return rows.length ? Object.keys(rows[0]) : [];
}

// Fetch one page. Returns { rows, hasNext }. Asks for perPage+1 to detect a
// following page without a COUNT query.
export async function fetchPage({ table, page = 1, perPage = 50, column = 'ALL', search = '' }) {
  const offset = (page - 1) * perPage;
  const where = buildWhere(column, search);
  const query = `SELECT * FROM ${table}${where} LIMIT ${offset}, ${perPage + 1}`;
  const resp = await zcql().executeQuery(query);
  const rows = flatten(resp, table);
  const hasNext = rows.length > perPage;
  return { rows: hasNext ? rows.slice(0, perPage) : rows, hasNext };
}

// Best-effort total row count (drives the "N records" label). Returns null on
// failure so the UI can still paginate via hasNext.
export async function fetchCount({ table, column = 'ALL', search = '' }) {
  try {
    const where = buildWhere(column, search);
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
