// Data for the Dashboard analytics section — live from the Data Store via
// browser ZCQL over the Police FIR schema. Same constraints as reports.js:
// no JOINs (no FK relationships), so grouped IDs are resolved to names
// client-side from the small master tables, and time buckets that ZCQL can't
// GROUP BY (months, age ranges) are computed with parallel COUNT queries.
import { runQuery } from './datastore';
import { groupCount } from './reports';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function scalar(sql, table) {
  const rows = await runQuery(sql, table);
  const r = rows[0] || {};
  return num(Object.values(r)[0]);
}

const countCases = (where = '') =>
  scalar(`SELECT COUNT(ROWID) AS c FROM CaseMaster${where}`, 'CaseMaster');

async function lookup(table, idCol, nameCol) {
  const rows = await runQuery(`SELECT ${idCol}, ${nameCol} FROM ${table} LIMIT 0, 300`, table);
  const map = new Map(rows.map((r) => [String(r[idCol]), r[nameCol]]));
  return (id) => map.get(String(id)) || String(id ?? '—');
}

// Solved = a final report reached the court or a closure was recorded.
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

export async function fetchDashboard() {
  const [statusName, headName, unitName, unitDistrict, districtName] = await Promise.all([
    lookup('CaseStatusMaster', 'CaseStatusID', 'CaseStatusName'),
    lookup('CrimeHead', 'CrimeHeadID', 'CrimeGroupName'),
    lookup('Unit', 'UnitID', 'UnitName'),
    lookup('Unit', 'UnitID', 'DistrictID'),
    lookup('District', 'DistrictID', 'DistrictName'),
  ]);

  const year = new Date().getFullYear();
  const months = monthWindows(12);

  const [
    total, open, heinous, arrests, chargesheets, thisYear, lastYearSame,
    byStatus, byHead, openByStation, trendCounts, ageCounts, recentRows,
  ] = await Promise.all([
    countCases(),
    countCases(' WHERE CaseStatusID = 1'),
    countCases(' WHERE GravityOffenceID = 1'),
    scalar('SELECT COUNT(ROWID) AS c FROM ArrestSurrender', 'ArrestSurrender'),
    scalar('SELECT COUNT(ROWID) AS c FROM ChargesheetDetails', 'ChargesheetDetails'),
    countCases(` WHERE CrimeRegisteredDate BETWEEN '${year}-01-01' AND '${year}-12-31'`),
    countCases(
      ` WHERE CrimeRegisteredDate BETWEEN '${year - 1}-01-01' AND '${year - 1}-${new Date()
        .toISOString()
        .slice(5, 10)}'`
    ),
    groupCount('CaseMaster', 'CaseStatusID', { nameOf: statusName }),
    groupCount('CaseMaster', 'CrimeMajorHeadID', { limit: 6, nameOf: headName }),
    groupCount('CaseMaster', 'PoliceStationID', {
      limit: 8,
      nameOf: (uid) => unitName(uid).replace(' Police Station', ''),
      where: ' WHERE CaseStatusID = 1',
    }),
    Promise.all(
      months.map((m) =>
        countCases(` WHERE CrimeRegisteredDate BETWEEN '${m.from}' AND '${m.to}'`)
      )
    ),
    Promise.all(
      AGE_BUCKETS.map((b) =>
        scalar(
          `SELECT COUNT(ROWID) AS c FROM Accused WHERE AgeYear BETWEEN ${b.from} AND ${b.to}`,
          'Accused'
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
      total,
      open,
      openPct: total ? (open / total) * 100 : 0,
      solvedPct: total ? (solved / total) * 100 : 0,
      heinousPct: total ? (heinous / total) * 100 : 0,
      arrests,
      chargesheets,
      thisYear,
      yoyPct: lastYearSame ? ((thisYear - lastYearSame) / lastYearSame) * 100 : null,
    },
    trend: months.map((m, i) => ({ label: m.label, value: trendCounts[i] })),
    byStatus,
    byHead,
    openByStation,
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
