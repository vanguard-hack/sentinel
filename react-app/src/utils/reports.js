// Aggregation queries for the Reports page against the Police FIR schema.
// Counts/GROUP BYs run server-side via ZCQL; because the Data Store tables
// have no declared FK relationships, ZCQL JOINs are unavailable — so grouped
// results come back as IDs and we resolve names client-side from the small
// master tables (fetched once per load, a few hundred rows total).
import { runQuery } from './datastore';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const labelOf = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
};

// COUNT(ROWID) grouped by a dimension → [{ label, value }] sorted desc.
// `nameOf` maps a raw dimension value (usually an ID) to a display label.
// `limit` folds the long tail into an "Other" bucket.
export async function groupCount(table, dim, { limit, nameOf } = {}) {
  const rows = await runQuery(
    `SELECT ${dim}, COUNT(ROWID) AS cnt FROM ${table} GROUP BY ${dim}`,
    table
  );
  let data = rows
    .map((r) => ({
      key: r[dim],
      label: nameOf ? nameOf(r[dim]) : labelOf(r[dim]),
      value: num(r.cnt ?? r['COUNT(ROWID)']),
    }))
    .filter((d) => d.value > 0);

  // Re-aggregate after name mapping (several keys can map to one label,
  // e.g. stations → district).
  const merged = new Map();
  for (const d of data) merged.set(d.label, (merged.get(d.label) || 0) + d.value);
  data = [...merged.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  if (limit && data.length > limit) {
    const head = data.slice(0, limit);
    const rest = data.slice(limit).reduce((s, d) => s + d.value, 0);
    if (rest > 0) head.push({ label: 'Other', value: rest });
    data = head;
  }
  return data;
}

async function scalar(sql, table, key) {
  const rows = await runQuery(sql, table);
  const r = rows[0] || {};
  return num(r[key] ?? Object.values(r)[0]);
}

// Fetch a master table once and return an id → name lookup function.
async function lookup(table, idCol, nameCol) {
  const rows = await runQuery(`SELECT ${idCol}, ${nameCol} FROM ${table} LIMIT 0, 300`, table);
  const map = new Map(rows.map((r) => [String(r[idCol]), r[nameCol]]));
  return (id) => map.get(String(id)) || labelOf(id);
}

export async function fetchKpis() {
  const [cases, accused, victims, arrests, chargesheets] = await Promise.all([
    scalar('SELECT COUNT(ROWID) AS c FROM CaseMaster', 'CaseMaster', 'c'),
    scalar('SELECT COUNT(ROWID) AS c FROM Accused', 'Accused', 'c'),
    scalar('SELECT COUNT(ROWID) AS c FROM Victim', 'Victim', 'c'),
    scalar('SELECT COUNT(ROWID) AS c FROM ArrestSurrender', 'ArrestSurrender', 'c'),
    scalar('SELECT COUNT(ROWID) AS c FROM ChargesheetDetails', 'ChargesheetDetails', 'c'),
  ]);
  return {
    firs: cases,
    accused,
    victims,
    arrests,
    chargesheets,
    chargesheetPct: cases > 0 ? (chargesheets / cases) * 100 : 0,
  };
}

// Everything the Reports page needs, in parallel.
export async function fetchReports() {
  // Master lookups first (small), then the grouped aggregations that use them.
  const [headName, statusName, unitDistrict, districtName, subHeadName] = await Promise.all([
    lookup('CrimeHead', 'CrimeHeadID', 'CrimeGroupName'),
    lookup('CaseStatusMaster', 'CaseStatusID', 'CaseStatusName'),
    lookup('Unit', 'UnitID', 'DistrictID'),
    lookup('District', 'DistrictID', 'DistrictName'),
    lookup('CrimeSubHead', 'CrimeSubHeadID', 'CrimeHeadName'),
  ]);

  const [kpis, byCategory, byStatus, byDistrict, bySubHead] = await Promise.all([
    fetchKpis(),
    groupCount('CaseMaster', 'CrimeMajorHeadID', { limit: 8, nameOf: headName }),
    groupCount('CaseMaster', 'CaseStatusID', { limit: 5, nameOf: statusName }),
    // CaseMaster has no district column: group by station, map station →
    // district → name; groupCount re-aggregates identical labels.
    groupCount('CaseMaster', 'PoliceStationID', {
      limit: 12,
      nameOf: (uid) => districtName(unitDistrict(uid)),
    }),
    groupCount('CaseMaster', 'CrimeMinorHeadID', { limit: 8, nameOf: subHeadName }),
  ]);
  return { kpis, byCategory, byStatus, byDistrict, bySubHead };
}
