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
export async function groupCount(table, dim, { limit, nameOf, where = '' } = {}) {
  const rows = await runQuery(
    `SELECT ${dim}, COUNT(ROWID) AS cnt FROM ${table}${where} GROUP BY ${dim}`,
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

// Solved = a final report reached the court or a decision was recorded.
const SOLVED_STATUSES = new Set(['Charge Sheeted', 'Pending Trial', 'Convicted', 'Acquitted']);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Last `n` calendar months ending this month → [{ label, from, to }].
function monthWindows(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const iso = (x) => x.toISOString().slice(0, 10);
    out.push({
      label: `${MONTHS[d.getMonth()]}${d.getMonth() === 0 ? ' ' + String(d.getFullYear()).slice(2) : ''}`,
      from: iso(d),
      to: iso(end),
    });
  }
  return out;
}

const AGE_BUCKETS = [
  { label: '18–25', from: 18, to: 25 },
  { label: '26–35', from: 26, to: 35 },
  { label: '36–45', from: 36, to: 45 },
  { label: '46–60', from: 46, to: 60 },
  { label: '60+', from: 61, to: 120 },
];

const countCases = (where = '') =>
  scalar(`SELECT COUNT(ROWID) AS c FROM CaseMaster${where}`, 'CaseMaster', 'c');

// Everything the Reports page needs, in parallel.
export async function fetchReports() {
  // Master lookups first (small), then the aggregations that use them.
  const [headName, statusName, unitName, unitDistrict, districtName, subHeadName] =
    await Promise.all([
      lookup('CrimeHead', 'CrimeHeadID', 'CrimeGroupName'),
      lookup('CaseStatusMaster', 'CaseStatusID', 'CaseStatusName'),
      lookup('Unit', 'UnitID', 'UnitName'),
      lookup('Unit', 'UnitID', 'DistrictID'),
      lookup('District', 'DistrictID', 'DistrictName'),
      lookup('CrimeSubHead', 'CrimeSubHeadID', 'CrimeHeadName'),
    ]);

  const year = new Date().getFullYear();
  const months = monthWindows(12);
  const YEARS = [];
  for (let y = 2023; y <= year; y++) YEARS.push(y);

  const [
    cases, accusedN, victims, arrests, chargesheets, open, heinous, thisYear, lastYearSame,
    byCategory, byStatus, byDistrict, bySubHead, openByStation,
    trendCounts, yearCounts, ageCounts, recentRows,
  ] = await Promise.all([
    countCases(),
    scalar('SELECT COUNT(ROWID) AS c FROM Accused', 'Accused', 'c'),
    scalar('SELECT COUNT(ROWID) AS c FROM Victim', 'Victim', 'c'),
    scalar('SELECT COUNT(ROWID) AS c FROM ArrestSurrender', 'ArrestSurrender', 'c'),
    scalar('SELECT COUNT(ROWID) AS c FROM ChargesheetDetails', 'ChargesheetDetails', 'c'),
    countCases(' WHERE CaseStatusID = 1'),
    countCases(' WHERE GravityOffenceID = 1'),
    countCases(` WHERE CrimeRegisteredDate BETWEEN '${year}-01-01' AND '${year}-12-31'`),
    countCases(
      ` WHERE CrimeRegisteredDate BETWEEN '${year - 1}-01-01' AND '${year - 1}-${new Date()
        .toISOString()
        .slice(5, 10)}'`
    ),
    groupCount('CaseMaster', 'CrimeMajorHeadID', { limit: 8, nameOf: headName }),
    groupCount('CaseMaster', 'CaseStatusID', { limit: 5, nameOf: statusName }),
    // CaseMaster has no district column: group by station, map station →
    // district → name; groupCount re-aggregates identical labels.
    groupCount('CaseMaster', 'PoliceStationID', {
      nameOf: (uid) => districtName(unitDistrict(uid)),
    }),
    groupCount('CaseMaster', 'CrimeMinorHeadID', { limit: 8, nameOf: subHeadName }),
    groupCount('CaseMaster', 'PoliceStationID', {
      limit: 8,
      nameOf: (uid) => String(unitName(uid)).replace(' Police Station', ''),
      where: ' WHERE CaseStatusID = 1',
    }),
    Promise.all(
      months.map((m) => countCases(` WHERE CrimeRegisteredDate BETWEEN '${m.from}' AND '${m.to}'`))
    ),
    Promise.all(
      YEARS.map((y) => countCases(` WHERE CrimeRegisteredDate BETWEEN '${y}-01-01' AND '${y}-12-31'`))
    ),
    Promise.all(
      AGE_BUCKETS.map((b) =>
        scalar(
          `SELECT COUNT(ROWID) AS c FROM Accused WHERE AgeYear BETWEEN ${b.from} AND ${b.to}`,
          'Accused',
          'c'
        )
      )
    ),
    runQuery(
      'SELECT CrimeNo, CrimeRegisteredDate, PoliceStationID, CrimeMajorHeadID, ' +
        'CaseStatusID, GravityOffenceID FROM CaseMaster ' +
        'ORDER BY CrimeRegisteredDate DESC LIMIT 0, 8',
      'CaseMaster'
    ),
  ]);

  const solved = byStatus
    .filter((d) => SOLVED_STATUSES.has(d.label))
    .reduce((s, d) => s + d.value, 0);

  return {
    kpis: {
      firs: cases,
      accused: accusedN,
      victims,
      arrests,
      chargesheets,
      chargesheetPct: cases > 0 ? (chargesheets / cases) * 100 : 0,
      open,
      openPct: cases ? (open / cases) * 100 : 0,
      solvedPct: cases ? (solved / cases) * 100 : 0,
      heinousPct: cases ? (heinous / cases) * 100 : 0,
      thisYear,
      yoyPct: lastYearSame ? ((thisYear - lastYearSame) / lastYearSame) * 100 : null,
    },
    byCategory,
    byStatus,
    // Bar chart shows top 12 + Other; the correlation map needs every district.
    byDistrict: (() => {
      if (byDistrict.length <= 12) return byDistrict;
      const head = byDistrict.slice(0, 12);
      const rest = byDistrict.slice(12).reduce((s, d) => s + d.value, 0);
      return rest > 0 ? [...head, { label: 'Other', value: rest }] : head;
    })(),
    crimeByDistrict: byDistrict,
    bySubHead,
    openByStation,
    trend: months.map((m, i) => ({ label: m.label, value: trendCounts[i] })),
    yearly: YEARS.map((y, i) => ({
      label: y === year ? `${y} (to date)` : String(y),
      value: yearCounts[i],
    })),
    accusedAges: AGE_BUCKETS.map((b, i) => ({ label: b.label, value: ageCounts[i] })),
    recent: recentRows.map((r) => ({
      crimeNo: r.CrimeNo,
      date: r.CrimeRegisteredDate,
      station: unitName(r.PoliceStationID),
      district: districtName(unitDistrict(r.PoliceStationID)),
      head: headName(r.CrimeMajorHeadID),
      status: statusName(r.CaseStatusID),
      heinous: String(r.GravityOffenceID) === '1',
    })),
  };
}
