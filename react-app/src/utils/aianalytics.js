// AI Analytics — temporal crime-pattern mining and forecasting.
//
// ZCQL cannot GROUP BY hour/day-of-month, so we page the incident timestamps
// down once (~2.2k rows, 4 columns) and compute every profile client-side.
// That also makes the crime-head filter instant — no re-querying.
import { runQuery, fetchSharedCases } from './datastore';
import { derived, invalidate } from './derived';


export async function fetchIncidents() {
  // 20 pages of 300 was a 6,000-row ceiling. At 2,200 cases it never bit; at
  // 30,000 it silently drew every chart on the first fifth of the data.
  const raw = await fetchSharedCases();
  const heads = await runQuery(
    'SELECT CrimeHeadID, CrimeGroupName FROM CrimeHead LIMIT 0, 50',
    'CrimeHead'
  );
  const headNames = Object.fromEntries(
    heads.map((h) => [String(h.CrimeHeadID), h.CrimeGroupName])
  );

  const incidents = raw
    .map((r) => {
      const ts = String(r.IncidentFromDate || '');
      const reg = String(r.CrimeRegisteredDate || '').slice(0, 10);
      return {
        hour: Number(ts.slice(11, 13)),
        dayOfMonth: Number(ts.slice(8, 10)),
        weekday: ts ? new Date(ts.slice(0, 10)).getDay() : NaN,
        month: reg.slice(0, 7),
        head: String(r.CrimeMajorHeadID),
      };
    })
    .filter((r) => Number.isFinite(r.hour) && r.month);
  return { incidents, headNames };
}

const pad2 = (n) => String(n).padStart(2, '0');

export function hourlyProfile(rows) {
  const counts = Array(24).fill(0);
  rows.forEach((r) => { counts[r.hour] += 1; });
  return counts.map((v, h) => ({ label: `${pad2(h)}:00`, value: v }));
}

export function dayOfMonthProfile(rows) {
  const counts = Array(31).fill(0);
  rows.forEach((r) => { if (r.dayOfMonth >= 1) counts[r.dayOfMonth - 1] += 1; });
  return counts.map((v, i) => ({ label: String(i + 1), value: v }));
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function weekdayProfile(rows) {
  const counts = Array(7).fill(0);
  rows.forEach((r) => { if (Number.isFinite(r.weekday)) counts[r.weekday] += 1; });
  return counts.map((v, i) => ({ label: WEEKDAYS[i], value: v }));
}

// Contiguous window of `size` buckets (wrapping) with the highest total —
// e.g. the 4-hour band when most crime happens.
export function peakWindow(profile, size) {
  const n = profile.length;
  let best = 0;
  let bestStart = 0;
  for (let s = 0; s < n; s++) {
    let sum = 0;
    for (let k = 0; k < size; k++) sum += profile[(s + k) % n].value;
    if (sum > best) { best = sum; bestStart = s; }
  }
  const total = profile.reduce((a, d) => a + d.value, 0) || 1;
  return { start: bestStart, end: (bestStart + size) % n, count: best, share: (best / total) * 100 };
}

// Monthly registration series with gaps filled, oldest → newest.
export function monthlySeries(rows) {
  const counts = new Map();
  rows.forEach((r) => counts.set(r.month, (counts.get(r.month) || 0) + 1));
  const keys = [...counts.keys()].sort();
  if (!keys.length) return [];
  const out = [];
  const [y0, m0] = keys[0].split('-').map(Number);
  const [y1, m1] = keys[keys.length - 1].split('-').map(Number);
  for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (y++, m = 1) : m++) {
    const key = `${y}-${pad2(m)}`;
    out.push({ key, label: `${key.slice(5)}/${String(y).slice(2)}`, value: counts.get(key) || 0 });
  }
  return out;
}

// Ordinary-least-squares linear trend over the last `window` points,
// projected `horizon` months ahead. A transparent statistical projection —
// deliberately simple, not a trained model — and clamped at zero.
export function forecastMonths(series, { window = 18, horizon = 3 } = {}) {
  const hist = series.slice(-window);
  const n = hist.length;
  if (n < 6) return { points: [], slope: 0 };
  const xs = hist.map((_, i) => i);
  const ys = hist.map((d) => d.value);
  const xm = xs.reduce((a, b) => a + b, 0) / n;
  const ym = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xm) * (ys[i] - ym);
    den += (xs[i] - xm) ** 2;
  }
  const slope = den ? num / den : 0;
  const intercept = ym - slope * xm;

  const last = series[series.length - 1].key.split('-').map(Number);
  const points = [];
  for (let h = 1; h <= horizon; h++) {
    let [y, m] = last;
    m += h;
    y += Math.floor((m - 1) / 12);
    m = ((m - 1) % 12) + 1;
    points.push({
      label: `${pad2(m)}/${String(y).slice(2)}`,
      value: Math.max(0, Math.round(intercept + slope * (n - 1 + h))),
      forecast: true,
    });
  }
  return { points, slope };
}

// Every incident's weekday x hour → a 7x24 grid, in calendar order (Sunday
// first, matching WEEKDAYS above) rather than sorted by volume — a day-of-week
// view reads by when it is, not by how busy it was.
export function weekdayHourMatrix(rows) {
  const grid = WEEKDAYS.map((day) => ({ day, cells: Array(24).fill(0), total: 0 }));
  rows.forEach((r) => {
    if (!Number.isFinite(r.weekday) || !Number.isFinite(r.hour)) return;
    grid[r.weekday].cells[r.hour] += 1;
    grid[r.weekday].total += 1;
  });
  return grid;
}

// Yearly registration totals, oldest -> newest, each flagged `complete` (all
// 12 months present in the gap-filled monthly series) or not. The dataset's
// most recent year is normally partial — it stops mid-year, not at
// December — and reading that as a real year-over-year drop would be
// comparing a part to a whole. Complete-vs-partial is what lets the chart
// (and the trend fit below) tell the difference.
export function yearlySeries(rows) {
  const months = monthlySeries(rows);
  const years = new Map(); // year -> { value, monthCount }
  months.forEach((m) => {
    const y = m.key.slice(0, 4);
    const e = years.get(y) || { value: 0, monthCount: 0 };
    e.value += m.value;
    e.monthCount += 1;
    years.set(y, e);
  });
  return [...years.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, e]) => ({ year, value: e.value, complete: e.monthCount === 12 }));
}

// Deterministic PRNG (mulberry32 — the same generator utils/patrol.js and
// utils/financial.js each already carry their own copy of, for the same
// reason: reproducible synthetic figures with no external dependency).
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A CLEARLY-LABELLED illustrative lead-in for the years before this
// (synthetic) dataset's own coverage starts — this platform's underlying
// case data only ever covers 2023 through mid-2026 (see CLAUDE.md); there is
// no real record, synthetic or otherwise, behind anything earlier. Rather
// than pretend to know a 13-year trend that was never modelled, each year is
// drawn independently around the first REAL year's level with bounded
// deterministic noise — a plausible-looking, admittedly-decorative backdrop,
// not a second forecast. Every point carries `illustrative: true`, which is
// what TrendArea uses to draw it dashed and unmistakably apart from the
// actual recorded years — see completePartialYear and forecastYears below
// for how those, by contrast, both stay strictly evidence-based.
export function illustrativeHistory(series, years = 13, seed = 20100101) {
  if (!series.length) return [];
  const anchor = series[0].value;
  const firstYear = Number(series[0].year);
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = years; i >= 1; i--) {
    const noise = (rnd() - 0.5) * 0.3; // +/-15% around the anchor level
    out.push({ year: String(firstYear - i), value: Math.max(0, Math.round(anchor * (1 + noise))), illustrative: true });
  }
  return out;
}

// If the trailing year in `series` is partial and `modelSeries.forecast` (a
// deployed QuickML monthly forecast, e.g. fc.total or fc.crimehead.series[k]
// from getForecasts()) reaches into it, tops that year up with the model's
// own predicted remaining months — real model output, not a second guess —
// rather than leaving the bar visibly short. A no-op (returns `series`
// unchanged) when there's no partial year, or the model's forecast doesn't
// happen to cover it.
export function completePartialYear(series, modelSeries) {
  const last = series[series.length - 1];
  if (!last || last.complete || !modelSeries?.forecast) return { series, modelCompleted: false };
  const remaining = modelSeries.forecast.filter((p) => p.month && p.month.startsWith(last.year) && p.value != null);
  if (!remaining.length) return { series, modelCompleted: false };
  const addedValue = remaining.reduce((s, p) => s + p.value, 0);
  return {
    series: [...series.slice(0, -1), { ...last, value: last.value + addedValue }],
    modelCompleted: true,
  };
}

// OLS linear trend over the COMPLETE years only — a partial year would drag
// the slope toward "decline" simply for not being over yet — projected
// `horizon` years past the last year actually IN the series (complete or
// partial), so a forecast never re-predicts a year already shown as an
// actual. Same honesty rule as forecastMonths: transparent, not a trained
// model, and only offered with at least 2 complete years to fit a line
// through.
export function forecastYears(series, horizon = 2) {
  const complete = series.filter((y) => y.complete);
  const n = complete.length;
  if (n < 2 || !series.length) return { points: [], slope: 0 };
  const xs = complete.map((_, i) => i);
  const ys = complete.map((y) => y.value);
  const xm = xs.reduce((a, b) => a + b, 0) / n;
  const ym = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xm) * (ys[i] - ym);
    den += (xs[i] - xm) ** 2;
  }
  const slope = den ? num / den : 0;
  const intercept = ym - slope * xm;

  const lastCompleteYear = Number(complete[n - 1].year);
  const lastYearInSeries = Number(series[series.length - 1].year);
  const points = [];
  for (let h = 1; h <= horizon; h++) {
    const targetYear = lastYearInSeries + h;
    const stepsFromFit = targetYear - lastCompleteYear; // >=1; skips any partial year already shown
    points.push({
      year: String(targetYear),
      value: Math.max(0, Math.round(intercept + slope * (n - 1 + stepsFromFit))),
      forecast: true,
    });
  }
  return { points, slope };
}

export const DAYPARTS = [
  { label: 'Night 00–06', from: 0, to: 5 },
  { label: 'Morning 06–12', from: 6, to: 11 },
  { label: 'Afternoon 12–18', from: 12, to: 17 },
  { label: 'Evening 18–24', from: 18, to: 23 },
];

// Crime head × daypart count matrix → [{ head, cells: [n,n,n,n], total }].
export function headDaypartMatrix(rows, headNames) {
  const acc = {};
  rows.forEach((r) => {
    const slot = DAYPARTS.findIndex((p) => r.hour >= p.from && r.hour <= p.to);
    if (slot < 0) return;
    (acc[r.head] = acc[r.head] || [0, 0, 0, 0])[slot] += 1;
  });
  return Object.entries(acc)
    .map(([head, cells]) => ({
      head: headNames[head] || head,
      cells,
      total: cells.reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total);
}


/* Held for the session — the incident coding is pure and the tab is one of five
   that get switched between. */
export const INCIDENTS_KEY = 'aiIncidents';
export const getIncidents = () => derived(INCIDENTS_KEY, fetchIncidents);
export function refreshIncidents() { invalidate(INCIDENTS_KEY); }
