// AI Analytics — temporal crime-pattern mining and forecasting.
//
// ZCQL cannot GROUP BY hour/day-of-month, so we page the incident timestamps
// down once (~2.2k rows, 4 columns) and compute every profile client-side.
// That also makes the crime-head filter instant — no re-querying.
import { runQuery } from './datastore';

const PAGE = 300; // ZCQL rows-per-query cap

export async function fetchIncidents() {
  const raw = [];
  for (let page = 0; page < 20; page++) {
    const rows = await runQuery(
      'SELECT CaseMasterID, IncidentFromDate, CrimeRegisteredDate, CrimeMajorHeadID ' +
        `FROM CaseMaster LIMIT ${page * PAGE}, ${PAGE}`,
      'CaseMaster'
    );
    raw.push(...rows);
    if (rows.length < PAGE) break;
  }
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
