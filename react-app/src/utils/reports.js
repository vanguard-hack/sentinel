// Reports data layer for the Police FIR schema.
//
// The Home dashboard is filtered by a single time range (day / month / year /
// 5y). Because the Data Store has no FK joins and can't date-filter the
// victim/accused/arrest/chargesheet tables (they carry no date column), we
// fetch the raw per-case rows ONCE, then compute every KPI and chart for the
// selected window entirely client-side — so changing the range is instant and
// filters the whole report, not just the trend chart.
import { runQuery } from './datastore';

const labelOf = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
};

const CAP = 300; // ZCQL rows-per-query cap

async function fetchAll(sql, table) {
  const out = [];
  for (let off = 0; off < 40000; off += CAP) {
    const rows = await runQuery(`${sql} LIMIT ${off}, ${CAP}`, table);
    out.push(...rows);
    if (rows.length < CAP) break;
  }
  return out;
}

// Fetch a master table once and return an id → name lookup function.
async function lookup(table, idCol, nameCol) {
  const rows = await fetchAll(`SELECT ${idCol}, ${nameCol} FROM ${table}`, table);
  const map = new Map(rows.map((r) => [String(r[idCol]), r[nameCol]]));
  return (id) => map.get(String(id)) || labelOf(id);
}

// Solved = a final report reached the court or a decision was recorded.
const SOLVED_STATUSES = new Set(['Charge Sheeted', 'Pending Trial', 'Convicted', 'Acquitted']);

const AGE_BUCKETS = [
  { label: '18–25', from: 18, to: 25 },
  { label: '26–35', from: 26, to: 35 },
  { label: '36–45', from: 36, to: 45 },
  { label: '46–60', from: 46, to: 60 },
  { label: '60+', from: 61, to: 120 },
];

// Time-range filter options for the Home dashboard. `windowDays` is the span of
// data each range covers; `bucket` is the trend-chart granularity.
export const TREND_RANGES = [
  { key: 'day', label: 'Today', bucket: 'day', days: 30, windowDays: 30 },
  { key: 'month', label: 'Month', bucket: 'month', months: 12, windowDays: 365 },
  { key: 'year', label: 'Year', bucket: 'week', months: 12, windowDays: 365 },
  { key: '5y', label: '5 Years', bucket: 'year', years: 5, windowDays: 365 * 5 },
];

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

// Build a [{ label, value }] series from raw 'YYYY-MM-DD' dates for a range.
// All bucketing is done in UTC so the keys used when counting the dates and the
// keys used when laying out the axis always agree (mixing local getDate() with
// UTC toISOString() silently drops every count — that was the "Past year" bug).
export function buildTrend(dates, rangeKey) {
  const range = TREND_RANGES.find((r) => r.key === rangeKey) || TREND_RANGES[1];
  const counts = new Map();

  const weekKey = (d) => {
    const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    u.setUTCDate(u.getUTCDate() - ((u.getUTCDay() + 6) % 7));
    return u.toISOString().slice(0, 10);
  };
  const key = (d) => {
    if (range.bucket === 'day') return d.toISOString().slice(0, 10);
    if (range.bucket === 'week') return weekKey(d);
    if (range.bucket === 'month') return d.toISOString().slice(0, 7);
    return String(d.getUTCFullYear());
  };
  dates.forEach((s) => {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) counts.set(key(d), (counts.get(key(d)) || 0) + 1);
  });

  const out = [];
  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

  if (range.bucket === 'day') {
    for (let i = range.days - 1; i >= 0; i--) {
      const d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
      const k = d.toISOString().slice(0, 10);
      out.push({ label: `${d.getUTCDate()}/${d.getUTCMonth() + 1}`, value: counts.get(k) || 0 });
    }
  } else if (range.bucket === 'week') {
    const weeks = Math.round((range.months * 52) / 12);
    const monday = new Date(today);
    monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
    for (let i = weeks - 1; i >= 0; i--) {
      const d = new Date(monday); d.setUTCDate(monday.getUTCDate() - i * 7);
      const k = d.toISOString().slice(0, 10);
      out.push({ label: `${d.getUTCDate()}/${d.getUTCMonth() + 1}`, value: counts.get(k) || 0 });
    }
  } else if (range.bucket === 'month') {
    for (let i = range.months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
      const k = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
      out.push({ label: `${MON[d.getUTCMonth()]}${d.getUTCMonth() === 0 ? " '" + String(d.getUTCFullYear()).slice(2) : ''}`, value: counts.get(k) || 0 });
    }
  } else {
    for (let i = range.years - 1; i >= 0; i--) {
      const y = today.getUTCFullYear() - i;
      out.push({ label: String(y), value: counts.get(String(y)) || 0 });
    }
  }
  return out;
}

// The [from, to) window (ms) a range covers, ending now.
export function windowFor(rangeKey) {
  const range = TREND_RANGES.find((r) => r.key === rangeKey) || TREND_RANGES[1];
  const to = Date.now();
  return { from: to - range.windowDays * 86400000, to };
}

// ── Raw fetch (once per load) ───────────────────────────────────────────────
export async function fetchReports() {
  const [headName, statusName, unitName, unitDistrict, districtName, subHeadName] =
    await Promise.all([
      lookup('CrimeHead', 'CrimeHeadID', 'CrimeGroupName'),
      lookup('CaseStatusMaster', 'CaseStatusID', 'CaseStatusName'),
      lookup('Unit', 'UnitID', 'UnitName'),
      lookup('Unit', 'UnitID', 'DistrictID'),
      lookup('District', 'DistrictID', 'DistrictName'),
      lookup('CrimeSubHead', 'CrimeSubHeadID', 'CrimeHeadName'),
    ]);

  const [caseRows, victimRows, accusedRows, arrestRows, csRows] = await Promise.all([
    fetchAll('SELECT CaseMasterID, CrimeRegisteredDate, PoliceStationID, CrimeMajorHeadID, CrimeMinorHeadID, CaseStatusID, GravityOffenceID FROM CaseMaster', 'CaseMaster'),
    fetchAll('SELECT CaseMasterID FROM Victim', 'Victim'),
    fetchAll('SELECT CaseMasterID, AgeYear FROM Accused', 'Accused'),
    fetchAll('SELECT CaseMasterID FROM ArrestSurrender', 'ArrestSurrender'),
    fetchAll('SELECT CaseMasterID FROM ChargesheetDetails', 'ChargesheetDetails'),
  ]);

  const cases = caseRows.map((c) => ({
    id: String(c.CaseMasterID),
    date: String(c.CrimeRegisteredDate || '').slice(0, 10),
    ts: Date.parse(String(c.CrimeRegisteredDate || '').slice(0, 10)),
    station: c.PoliceStationID,
    major: c.CrimeMajorHeadID,
    minor: c.CrimeMinorHeadID,
    status: c.CaseStatusID,
    gravity: c.GravityOffenceID,
  }));

  return {
    masters: { headName, statusName, unitName, unitDistrict, districtName, subHeadName },
    raw: {
      cases,
      caseDates: cases.map((c) => c.date).filter(Boolean),
      victimCases: victimRows.map((r) => String(r.CaseMasterID)),
      accused: accusedRows.map((r) => ({ caseId: String(r.CaseMasterID), age: Number(r.AgeYear) || 0 })),
      arrestCases: arrestRows.map((r) => String(r.CaseMasterID)),
      chargesheetCases: csRows.map((r) => String(r.CaseMasterID)),
    },
  };
}

// ── Client-side aggregation for the selected window ─────────────────────────
function groupCount(rows, keyFn, nameFn) {
  const m = new Map();
  rows.forEach((r) => {
    const k = keyFn(r);
    if (k === null || k === undefined || k === '') return;
    const label = nameFn(k);
    m.set(label, (m.get(label) || 0) + 1);
  });
  return [...m.entries()]
    .map(([label, value]) => ({ label, value }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);
}

function capOther(arr, limit) {
  if (!limit || arr.length <= limit) return arr;
  const head = arr.slice(0, limit);
  const rest = arr.slice(limit).reduce((s, d) => s + d.value, 0);
  return rest > 0 ? [...head, { label: 'Other', value: rest }] : head;
}

export function computeReport(raw, masters, rangeKey) {
  const { headName, statusName, unitName, unitDistrict, districtName, subHeadName } = masters;
  const { from, to } = windowFor(rangeKey);
  const span = to - from;

  const wcases = raw.cases.filter((c) => Number.isFinite(c.ts) && c.ts >= from && c.ts <= to);
  const idSet = new Set(wcases.map((c) => c.id));
  const firs = wcases.length;

  const open = wcases.filter((c) => String(c.status) === '1').length;
  const heinous = wcases.filter((c) => String(c.gravity) === '1').length;
  const solved = wcases.filter((c) => SOLVED_STATUSES.has(statusName(c.status))).length;

  const victims = raw.victimCases.reduce((n, id) => n + (idSet.has(id) ? 1 : 0), 0);
  const accusedRows = raw.accused.filter((a) => idSet.has(a.caseId));
  const accused = accusedRows.length;
  const arrests = raw.arrestCases.reduce((n, id) => n + (idSet.has(id) ? 1 : 0), 0);
  const chargesheets = raw.chargesheetCases.reduce((n, id) => n + (idSet.has(id) ? 1 : 0), 0);

  const byCategory = capOther(groupCount(wcases, (c) => c.major, (id) => headName(id)), 8);
  const byStatus = capOther(groupCount(wcases, (c) => c.status, (id) => statusName(id)), 5);
  const bySubHead = capOther(groupCount(wcases, (c) => c.minor, (id) => subHeadName(id)), 8);
  const byDistrictAll = groupCount(wcases, (c) => c.station, (uid) => districtName(unitDistrict(uid)));
  const openByStation = capOther(
    groupCount(
      wcases.filter((c) => String(c.status) === '1'),
      (c) => c.station,
      (uid) => String(unitName(uid)).replace(' Police Station', '')
    ),
    8
  );

  const accusedAges = AGE_BUCKETS.map((b) => ({
    label: b.label,
    value: accusedRows.filter((a) => a.age >= b.from && a.age <= b.to).length,
  }));

  const yearMap = new Map();
  wcases.forEach((c) => { const y = c.date.slice(0, 4); if (y) yearMap.set(y, (yearMap.get(y) || 0) + 1); });
  const yearly = [...yearMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([y, v]) => ({ label: y, value: v }));

  // vs the immediately-preceding window of the same length.
  const prevFirs = raw.cases.reduce(
    (n, c) => n + (Number.isFinite(c.ts) && c.ts >= from - span && c.ts < from ? 1 : 0), 0
  );
  const deltaPct = prevFirs ? ((firs - prevFirs) / prevFirs) * 100 : null;

  return {
    range: rangeKey,
    rangeLabel: (TREND_RANGES.find((r) => r.key === rangeKey) || TREND_RANGES[1]).label,
    kpis: {
      firs, accused, victims, arrests, chargesheets,
      chargesheetPct: firs ? (chargesheets / firs) * 100 : 0,
      open,
      openPct: firs ? (open / firs) * 100 : 0,
      solvedPct: firs ? (solved / firs) * 100 : 0,
      heinousPct: firs ? (heinous / firs) * 100 : 0,
      deltaPct,
    },
    byCategory,
    byStatus,
    byDistrict: capOther(byDistrictAll, 12),
    crimeByDistrict: byDistrictAll,
    bySubHead,
    openByStation,
    yearly,
    accusedAges,
    caseDates: raw.caseDates,
  };
}
