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

// A custom range is { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } (inclusive).
// Chart granularity scales with the span so the series stays readable.
function customBucket(custom) {
  const days =
    (Date.parse(custom.to) - Date.parse(custom.from)) / 86400000 + 1;
  if (days <= 45) return 'day';
  if (days <= 200) return 'week';
  if (days <= 1100) return 'month';
  return 'year';
}

const fmtShort = (iso) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });

export const customLabel = (custom) =>
  `${fmtShort(custom.from)} – ${fmtShort(custom.to)}`;

// Build a [{ label, value }] series from raw 'YYYY-MM-DD' dates for a range.
// All bucketing is done in UTC so the keys used when counting the dates and the
// keys used when laying out the axis always agree (mixing local getDate() with
// UTC toISOString() silently drops every count — that was the "Past year" bug).
export function buildTrend(dates, rangeKey, custom) {
  const range = TREND_RANGES.find((r) => r.key === rangeKey) || TREND_RANGES[1];
  const bucket = custom ? customBucket(custom) : range.bucket;
  const counts = new Map();

  const weekKey = (d) => {
    const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    u.setUTCDate(u.getUTCDate() - ((u.getUTCDay() + 6) % 7));
    return u.toISOString().slice(0, 10);
  };
  const key = (d) => {
    if (bucket === 'day') return d.toISOString().slice(0, 10);
    if (bucket === 'week') return weekKey(d);
    if (bucket === 'month') return d.toISOString().slice(0, 7);
    return String(d.getUTCFullYear());
  };
  dates.forEach((s) => {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) counts.set(key(d), (counts.get(key(d)) || 0) + 1);
  });

  // Axis window [start, end] in UTC days: the custom range verbatim, or the
  // preset's span ending today.
  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  let start;
  let end;
  if (custom) {
    start = new Date(custom.from + 'T00:00:00Z');
    end = new Date(custom.to + 'T00:00:00Z');
  } else {
    end = today;
    start = new Date(today);
    if (bucket === 'day') {
      start.setUTCDate(today.getUTCDate() - (range.days - 1));
    } else if (bucket === 'week') {
      start.setUTCDate(today.getUTCDate() - (Math.round((range.months * 52) / 12) - 1) * 7);
    } else if (bucket === 'month') {
      start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (range.months - 1), 1));
    } else {
      start = new Date(Date.UTC(today.getUTCFullYear() - (range.years - 1), 0, 1));
    }
  }

  const out = [];
  const dayLabel = (d) => `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  if (bucket === 'day') {
    for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push({ label: dayLabel(d), value: counts.get(d.toISOString().slice(0, 10)) || 0 });
    }
  } else if (bucket === 'week') {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // snap to Monday
    for (; d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
      out.push({ label: dayLabel(d), value: counts.get(d.toISOString().slice(0, 10)) || 0 });
    }
  } else if (bucket === 'month') {
    for (
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      d <= end;
      d.setUTCMonth(d.getUTCMonth() + 1)
    ) {
      const k = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
      // Month labels always carry the year: "Jan 24".
      out.push({ label: `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`, value: counts.get(k) || 0 });
    }
  } else {
    for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) {
      out.push({ label: String(y), value: counts.get(String(y)) || 0 });
    }
  }
  return out;
}

// The [from, to] window (ms) a range covers — the custom range verbatim
// (inclusive of the whole `to` day), or the preset's span ending now.
export function windowFor(rangeKey, custom) {
  if (custom) {
    return {
      from: Date.parse(custom.from + 'T00:00:00Z'),
      to: Date.parse(custom.to + 'T00:00:00Z') + 86399999,
    };
  }
  const range = TREND_RANGES.find((r) => r.key === rangeKey) || TREND_RANGES[1];
  const to = Date.now();
  return { from: to - range.windowDays * 86400000, to };
}

// ── Raw fetch (once per load) ───────────────────────────────────────────────
export async function fetchReports() {
  const [
    headName, statusName, unitName, unitDistrict, districtName, subHeadName,
    categoryName, courtName, occupationName, sectionName, actName, rankName,
  ] = await Promise.all([
    lookup('CrimeHead', 'CrimeHeadID', 'CrimeGroupName'),
    lookup('CaseStatusMaster', 'CaseStatusID', 'CaseStatusName'),
    lookup('Unit', 'UnitID', 'UnitName'),
    lookup('Unit', 'UnitID', 'DistrictID'),
    lookup('District', 'DistrictID', 'DistrictName'),
    lookup('CrimeSubHead', 'CrimeSubHeadID', 'CrimeHeadName'),
    lookup('CaseCategory', 'CaseCategoryID', 'LookupValue'),
    lookup('Court', 'CourtID', 'CourtName'),
    lookup('OccupationMaster', 'OccupationID', 'OccupationName'),
    lookup('Section', 'SectionCode', 'SectionDescription'),
    lookup('Act', 'ActCode', 'ShortName'),
    lookup('Rank', 'RankID', 'RankName'),
  ]);

  const [caseRows, victimRows, accusedRows, arrestRows, csRows, asaRows, complRows, empRows] =
    await Promise.all([
      fetchAll('SELECT CaseMasterID, CrimeRegisteredDate, PoliceStationID, CrimeMajorHeadID, CrimeMinorHeadID, CaseStatusID, GravityOffenceID, CaseCategoryID, PolicePersonID, CourtID FROM CaseMaster', 'CaseMaster'),
      fetchAll('SELECT CaseMasterID, VictimPolice FROM Victim', 'Victim'),
      fetchAll('SELECT CaseMasterID, AgeYear, GenderID, PersonID, AccusedName FROM Accused', 'Accused'),
      fetchAll('SELECT CaseMasterID, ArrestSurrenderTypeID, ArrestSurrenderDate FROM ArrestSurrender', 'ArrestSurrender'),
      fetchAll('SELECT CaseMasterID, csdate FROM ChargesheetDetails', 'ChargesheetDetails'),
      fetchAll('SELECT CaseMasterID, ActID, SectionID FROM ActSectionAssociation', 'ActSectionAssociation'),
      fetchAll('SELECT CaseMasterID, AgeYear, GenderID, OccupationID FROM ComplainantDetails', 'ComplainantDetails'),
      fetchAll('SELECT EmployeeID, FirstName, RankID, UnitID FROM Employee', 'Employee'),
    ]);

  const day = (v) => String(v || '').slice(0, 10);
  const cases = caseRows.map((c) => ({
    id: String(c.CaseMasterID),
    date: day(c.CrimeRegisteredDate),
    ts: Date.parse(day(c.CrimeRegisteredDate)),
    station: c.PoliceStationID,
    major: c.CrimeMajorHeadID,
    minor: c.CrimeMinorHeadID,
    status: c.CaseStatusID,
    gravity: c.GravityOffenceID,
    category: c.CaseCategoryID,
    io: c.PolicePersonID,
    court: c.CourtID,
  }));

  return {
    masters: {
      headName, statusName, unitName, unitDistrict, districtName, subHeadName,
      categoryName, courtName, occupationName, sectionName, actName, rankName,
    },
    raw: {
      cases,
      caseDates: cases.map((c) => c.date).filter(Boolean),
      victims: victimRows.map((r) => ({
        caseId: String(r.CaseMasterID),
        police: String(r.VictimPolice) === 'true' || String(r.VictimPolice) === '1',
      })),
      victimCases: victimRows.map((r) => String(r.CaseMasterID)),
      accused: accusedRows.map((r) => ({
        caseId: String(r.CaseMasterID),
        age: Number(r.AgeYear) || 0,
        gender: String(r.GenderID),
        person: String(r.PersonID || ''),
        name: r.AccusedName || '',
      })),
      arrests: arrestRows.map((r) => ({
        caseId: String(r.CaseMasterID),
        type: String(r.ArrestSurrenderTypeID),
        ts: Date.parse(day(r.ArrestSurrenderDate)),
      })),
      arrestCases: arrestRows.map((r) => String(r.CaseMasterID)),
      chargesheets: csRows.map((r) => ({
        caseId: String(r.CaseMasterID),
        ts: Date.parse(day(r.csdate)),
      })),
      chargesheetCases: csRows.map((r) => String(r.CaseMasterID)),
      actSections: asaRows.map((r) => ({
        caseId: String(r.CaseMasterID),
        act: String(r.ActID),
        section: String(r.SectionID),
      })),
      complainants: complRows.map((r) => ({
        caseId: String(r.CaseMasterID),
        age: Number(r.AgeYear) || 0,
        gender: String(r.GenderID),
        occupation: String(r.OccupationID),
      })),
      employees: empRows.map((r) => ({
        id: String(r.EmployeeID),
        name: r.FirstName || '',
        rank: String(r.RankID),
        unit: String(r.UnitID),
      })),
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
  // When the long tail out-sums the biggest real category, an "Other" bar
  // would dominate the scale and squash everything else — drop it instead.
  if (rest > (head[0]?.value || 0)) return head;
  return rest > 0 ? [...head, { label: 'Other', value: rest }] : head;
}

export function computeReport(raw, masters, rangeKey, custom) {
  const {
    headName, statusName, unitName, unitDistrict, districtName, subHeadName,
    categoryName, courtName, occupationName, sectionName, actName, rankName,
  } = masters;
  const { from, to } = windowFor(rangeKey, custom);
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

  // ── Extended analytics (all window-scoped unless noted) ──────────────────

  // Month buckets spanning the window, for the multi-series time charts.
  const buckets = [];
  {
    const s = new Date(from);
    const d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1));
    while (d.getTime() <= to && buckets.length < 80) {
      buckets.push({
        key: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`,
        label: `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`,
      });
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  }
  const bucketIdx = new Map(buckets.map((b, i) => [b.key, i]));
  const monthKeyOf = (ts) => {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  };
  const caseById = new Map(wcases.map((c) => [c.id, c]));

  // Crime trend split by head — the 5 biggest heads in the window.
  const topHeads = groupCount(wcases, (c) => c.major, (id) => headName(id)).slice(0, 5);
  const headIds = new Map(); // head label -> series row
  const trendByHead = topHeads.map((h) => ({
    name: h.label,
    points: buckets.map((b) => ({ label: b.label, value: 0 })),
  }));
  topHeads.forEach((h, i) => headIds.set(h.label, i));
  wcases.forEach((c) => {
    const row = headIds.get(headName(c.major));
    const bi = bucketIdx.get(monthKeyOf(c.ts));
    if (row != null && bi != null) trendByHead[row].points[bi].value++;
  });

  // Arrests vs surrenders over time (by the event's own date).
  const AS_TYPE = { 1: 'Arrest', 2: 'Surrender' };
  const arrestSeries = ['1', '2'].map((t) => ({
    name: AS_TYPE[t] || `Type ${t}`,
    points: buckets.map((b) => ({ label: b.label, value: 0 })),
  }));
  raw.arrests.forEach((a) => {
    if (!Number.isFinite(a.ts) || a.ts < from || a.ts > to) return;
    const bi = bucketIdx.get(monthKeyOf(a.ts));
    const row = a.type === '2' ? 1 : 0;
    if (bi != null) arrestSeries[row].points[bi].value++;
  });

  // Seasonality: calendar month × top 6 crime heads.
  const seasonHeads = groupCount(wcases, (c) => c.major, (id) => headName(id)).slice(0, 6);
  const seasonIdx = new Map(seasonHeads.map((h, i) => [h.label, i]));
  const seasonality = {
    rows: seasonHeads.map((h) => h.label),
    cols: MON,
    values: seasonHeads.map(() => Array(12).fill(0)),
  };
  wcases.forEach((c) => {
    const r = seasonIdx.get(headName(c.major));
    if (r != null) seasonality.values[r][new Date(c.ts).getUTCMonth()]++;
  });

  // Chargesheet filing lag + average investigation time by head.
  const LAG_BUCKETS = [
    { label: '≤ 30 days', to: 30 }, { label: '31–60', to: 60 }, { label: '61–90', to: 90 },
    { label: '91–180', to: 180 }, { label: '180+ days', to: Infinity },
  ];
  const csLag = LAG_BUCKETS.map((b) => ({ label: b.label, value: 0 }));
  const headLag = new Map(); // head -> { sum, n }
  raw.chargesheets.forEach((cs) => {
    const c = caseById.get(cs.caseId);
    if (!c || !Number.isFinite(cs.ts) || !Number.isFinite(c.ts)) return;
    const days = Math.max(0, Math.round((cs.ts - c.ts) / 86400000));
    csLag[LAG_BUCKETS.findIndex((b) => days <= b.to)].value++;
    const h = headName(c.major);
    const agg = headLag.get(h) || { sum: 0, n: 0 };
    agg.sum += days; agg.n++;
    headLag.set(h, agg);
  });
  const investTimeByHead = [...headLag.entries()]
    .filter(([, a]) => a.n >= 3)
    .map(([label, a]) => ({ label, value: Math.round(a.sum / a.n) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  // Composition splits.
  const gravitySplit = groupCount(wcases, (c) => c.gravity,
    (id) => (String(id) === '1' ? 'Heinous' : 'Non-heinous'));
  const categorySplit = groupCount(wcases, (c) => c.category, (id) => categoryName(id));
  // Compact section labels: "IPC 354 — Outraging modesty". Long statutory
  // descriptions shrink to their operative words.
  const SECTION_SHORT = {
    'Assault on woman with intent to outrage modesty': 'Outraging modesty',
    'Insult to modesty of woman': 'Insulting modesty',
    'Cruelty by husband or relatives': 'Domestic cruelty',
    'Voluntarily causing hurt': 'Causing hurt',
    'Hurt by dangerous weapons': 'Hurt by weapon',
    'Theft in dwelling house': 'House theft',
    'Criminal breach of trust': 'Breach of trust',
    'Criminal intimidation': 'Intimidation',
    'Death by negligence': 'Negligent death',
    'Rash driving on public way': 'Rash driving',
    'Possession of cannabis': 'Cannabis',
    'Possession of manufactured drugs': 'Manufactured drugs',
    'Possession of psychotropic substances': 'Psychotropics',
    'Possession of illegal arms': 'Illegal arms',
    'Computer-related offences': 'Computer offences',
    'Cheating by personation using computer': 'Online personation',
    'Obscene material online': 'Online obscenity',
    'Penetrative sexual assault': 'Penetrative assault',
    'Illegal sale of liquor': 'Illicit liquor',
    'Gambling in public place': 'Public gambling',
    'Taking dowry': 'Taking dowry',
    'Demanding dowry': 'Demanding dowry',
  };
  const topSections = capOther(
    groupCount(
      raw.actSections.filter((a) => idSet.has(a.caseId)),
      (a) => `${a.act}|${a.section}`,
      (k) => {
        const [act, sec] = k.split('|');
        const desc = sectionName(sec);
        return `${String(actName(act)).replace(' Act', '')} ${sec} — ${SECTION_SHORT[desc] || desc}`;
      }
    ),
    8
  );

  // Lifecycle: ordered funnel + pendency ageing of open cases.
  const FUNNEL_ORDER = ['Under Investigation', 'Charge Sheeted', 'Pending Trial', 'Convicted', 'Acquitted'];
  const statusCounts = new Map(byStatus.map((d) => [d.label, d.value]));
  groupCount(wcases, (c) => c.status, (id) => statusName(id)).forEach((d) => {
    if (!statusCounts.has(d.label)) statusCounts.set(d.label, d.value);
  });
  const statusFunnel = FUNNEL_ORDER
    .map((label) => ({ label, value: statusCounts.get(label) || 0 }))
    .filter((d) => d.value > 0);

  const AGEING = [
    { label: '< 3 months', to: 91 }, { label: '3–6 months', to: 183 },
    { label: '6–12 months', to: 366 }, { label: '1–2 years', to: 731 },
    { label: '2+ years', to: Infinity },
  ];
  const pendencyAgeing = AGEING.map((b) => ({ label: b.label, value: 0 }));
  const nowTs = Date.now();
  wcases.forEach((c) => {
    if (String(c.status) !== '1' || !Number.isFinite(c.ts)) return;
    const days = (nowTs - c.ts) / 86400000;
    pendencyAgeing[AGEING.findIndex((b) => days <= b.to)].value++;
  });

  // People & demographics.
  const wcompl = raw.complainants.filter((p) => idSet.has(p.caseId));
  const complainantOccupations = capOther(
    groupCount(wcompl, (p) => p.occupation, (id) => occupationName(id)), 8);
  const complainantAges = AGE_BUCKETS.map((b) => ({
    label: b.label,
    value: wcompl.filter((p) => p.age >= b.from && p.age <= b.to).length,
  }));
  const GENDER = { 1: 'Male', 2: 'Female' };
  const accusedGender = groupCount(accusedRows, (a) => a.gender, (id) => GENDER[id] || 'Other');

  const personAgg = new Map();
  accusedRows.forEach((a) => {
    if (!a.person) return;
    const agg = personAgg.get(a.person) || { name: a.name, cases: new Set() };
    agg.cases.add(a.caseId);
    personAgg.set(a.person, agg);
  });
  const repeatOffenders = [...personAgg.entries()]
    .map(([person, a]) => ({ label: `${a.name || person}`, value: a.cases.size }))
    .filter((d) => d.value >= 2)
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  const wvictims = raw.victims.filter((v) => idSet.has(v.caseId));
  const victimPoliceSplit = [
    { label: 'Civilians', value: wvictims.filter((v) => !v.police).length },
    { label: 'Police personnel', value: wvictims.filter((v) => v.police).length },
  ].filter((d) => d.value > 0);

  const arrestOutcome = groupCount(
    raw.arrests.filter((a) => idSet.has(a.caseId)),
    (a) => a.type,
    (id) => AS_TYPE[id] || `Type ${id}`
  );

  // Personnel & workload. Rank mix and staffing are force-wide (not windowed).
  const empName = new Map(raw.employees.map((e) => [e.id, e.name]));
  const ioCaseload = capOther(
    groupCount(wcases, (c) => c.io, (id) => empName.get(String(id)) || `Officer ${id}`), 8);

  const rankDistribution = capOther(
    groupCount(raw.employees, (e) => e.rank, (id) => rankName(id)), 5);

  const unitStaff = new Map();
  raw.employees.forEach((e) => unitStaff.set(e.unit, (unitStaff.get(e.unit) || 0) + 1));
  const unitCases = new Map();
  wcases.forEach((c) => unitCases.set(String(c.station), (unitCases.get(String(c.station)) || 0) + 1));
  const staffingVsCases = [...unitCases.entries()]
    .filter(([u]) => unitStaff.has(u))
    .map(([u, cases]) => ({
      x: unitStaff.get(u),
      y: cases,
      label: String(unitName(u)).replace(' Police Station', ' PS'),
    }));

  const courtLoad = capOther(
    groupCount(
      raw.chargesheets.filter((cs) => idSet.has(cs.caseId)),
      (cs) => caseById.get(cs.caseId)?.court,
      (id) => String(courtName(id)).replace(' District & Sessions Court', ' Sessions')
    ),
    8
  );

  // vs the immediately-preceding window of the same length.
  const prevFirs = raw.cases.reduce(
    (n, c) => n + (Number.isFinite(c.ts) && c.ts >= from - span && c.ts < from ? 1 : 0), 0
  );
  const deltaPct = prevFirs ? ((firs - prevFirs) / prevFirs) * 100 : null;

  return {
    range: rangeKey,
    rangeLabel: custom
      ? customLabel(custom)
      : (TREND_RANGES.find((r) => r.key === rangeKey) || TREND_RANGES[1]).label,
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
    // extended analytics
    trendByHead,
    arrestSeries,
    seasonality,
    csLag,
    investTimeByHead,
    gravitySplit,
    categorySplit,
    topSections,
    statusFunnel,
    pendencyAgeing,
    complainantOccupations,
    complainantAges,
    accusedGender,
    repeatOffenders,
    victimPoliceSplit,
    arrestOutcome,
    ioCaseload,
    rankDistribution,
    staffingVsCases,
    courtLoad,
  };
}
