// Predictive analytics for the AI Analytics → Forecasts view.
//
// Everything runs client-side on weekly aggregates (per the data-volume
// reality: ~2,200 FIRs forecast noise at day/station grain). Methods are
// deliberately classical and honest:
//   • Forecasting — Holt double exponential smoothing (level + trend) with a
//     small grid search over (alpha, beta); confidence bands from one-step
//     residual σ scaled by √horizon.
//   • District risk — percentile blend of recent level and 8-vs-8-week
//     growth; tiers are tertiles.
//   • Repeat-offender risk — transparent additive score (frequency, recency,
//     severity, co-accused network degree), each contribution reported so
//     the UI can explain every score.
//   • Anomalies — z-score of the latest weeks against a trailing 12-week
//     baseline per crime head and per district.
//
// Fairness: no protected attributes (religion/caste/gender) are ever used as
// features; outputs are decision support for humans, not automated targeting.

import { runQuery } from './datastore';

const PAGE = 300;

async function fetchAll(sql, table) {
  const out = [];
  for (let off = 0; off < 20000; off += PAGE) {
    const rows = await runQuery(`${sql} LIMIT ${off}, ${PAGE}`, table);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function fetchPredictData() {
  const [caseRows, accusedRows, unitRows, districtRows, headRows] = await Promise.all([
    fetchAll('SELECT CaseMasterID, CrimeRegisteredDate, PoliceStationID, CrimeMajorHeadID, GravityOffenceID FROM CaseMaster', 'CaseMaster'),
    fetchAll('SELECT CaseMasterID, PersonID, AccusedName FROM Accused', 'Accused'),
    fetchAll('SELECT UnitID, DistrictID FROM Unit', 'Unit'),
    fetchAll('SELECT DistrictID, DistrictName FROM District', 'District'),
    fetchAll('SELECT CrimeHeadID, CrimeGroupName FROM CrimeHead', 'CrimeHead'),
  ]);

  const unitDistrict = new Map(unitRows.map((u) => [String(u.UnitID), String(u.DistrictID)]));
  const districtName = new Map(districtRows.map((d) => [String(d.DistrictID), d.DistrictName]));
  const headName = new Map(headRows.map((h) => [String(h.CrimeHeadID), h.CrimeGroupName]));

  const cases = caseRows
    .map((c) => ({
      id: String(c.CaseMasterID),
      ts: Date.parse(String(c.CrimeRegisteredDate || '').slice(0, 10)),
      head: headName.get(String(c.CrimeMajorHeadID)) || 'Other',
      district: districtName.get(unitDistrict.get(String(c.PoliceStationID))) || 'Unknown',
      heinous: String(c.GravityOffenceID) === '1',
    }))
    .filter((c) => Number.isFinite(c.ts));

  const accused = accusedRows.map((a) => ({
    caseId: String(a.CaseMasterID),
    person: String(a.PersonID || ''),
    name: a.AccusedName || '',
  }));

  return { cases, accused };
}

// ── Weekly aggregation ───────────────────────────────────────────────────────
const WEEK = 7 * 86400000;
const mondayTs = (ts) => {
  const d = new Date(ts);
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  m.setUTCDate(m.getUTCDate() - ((m.getUTCDay() + 6) % 7));
  return m.getTime();
};
const weekLabel = (ts) => {
  const d = new Date(ts);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
};

// Gap-filled weekly counts over the data span (ending at the current week).
export function weeklyCounts(tsList) {
  if (!tsList.length) return [];
  const counts = new Map();
  tsList.forEach((ts) => {
    const w = mondayTs(ts);
    counts.set(w, (counts.get(w) || 0) + 1);
  });
  const start = Math.min(...counts.keys());
  const end = mondayTs(Date.now());
  const out = [];
  for (let w = start; w <= end; w += WEEK) {
    out.push({ ts: w, label: weekLabel(w), value: counts.get(w) || 0 });
  }
  return out;
}

// ── Holt double exponential smoothing with CI ────────────────────────────────
function holtFit(values, alpha, beta) {
  let level = values[0];
  let trend = values.length > 1 ? values[1] - values[0] : 0;
  let sse = 0;
  const resid = [];
  for (let i = 1; i < values.length; i++) {
    const pred = level + trend;
    const err = values[i] - pred;
    sse += err * err;
    resid.push(err);
    const prevLevel = level;
    level = alpha * values[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  return { level, trend, sse, resid };
}

// Forecast `h` weeks ahead. Returns { mean, lo, hi } arrays plus fit params.
export function holtForecast(series, h) {
  const values = series.map((p) => p.value);
  if (values.length < 8) return null;

  let best = null;
  for (const alpha of [0.2, 0.35, 0.5, 0.65]) {
    for (const beta of [0.05, 0.1, 0.2]) {
      const fit = holtFit(values, alpha, beta);
      if (!best || fit.sse < best.sse) best = { ...fit, alpha, beta };
    }
  }
  const sigma = Math.sqrt(best.sse / Math.max(1, best.resid.length));
  const lastTs = series[series.length - 1].ts;

  const points = [];
  for (let k = 1; k <= h; k++) {
    const mean = Math.max(0, best.level + k * best.trend);
    const half = 1.96 * sigma * Math.sqrt(k);
    points.push({
      ts: lastTs + k * WEEK,
      label: weekLabel(lastTs + k * WEEK),
      value: Math.round(mean * 10) / 10,
      lo: Math.max(0, Math.round((mean - half) * 10) / 10),
      hi: Math.round((mean + half) * 10) / 10,
    });
  }
  return { points, alpha: best.alpha, beta: best.beta, sigma };
}

// ── District risk scoring ────────────────────────────────────────────────────
const pctile = (sorted, v) => {
  let i = 0;
  while (i < sorted.length && sorted[i] <= v) i++;
  return sorted.length ? i / sorted.length : 0;
};

export function districtRisk(cases) {
  const byDistrict = new Map();
  cases.forEach((c) => {
    if (c.district === 'Unknown') return;
    if (!byDistrict.has(c.district)) byDistrict.set(c.district, []);
    byDistrict.get(c.district).push(c.ts);
  });

  const now = mondayTs(Date.now());
  const rows = [...byDistrict.entries()].map(([district, tsList]) => {
    const recent = tsList.filter((t) => t >= now - 8 * WEEK).length;
    const prev = tsList.filter((t) => t >= now - 16 * WEEK && t < now - 8 * WEEK).length;
    const growth = prev > 0 ? (recent - prev) / prev : recent > 0 ? 1 : 0;
    const fc = holtForecast(weeklyCounts(tsList), 4);
    const predicted = fc ? Math.round(fc.points.reduce((s, p) => s + p.value, 0)) : null;
    return { district, recent, prev, growth, predicted };
  });

  const levels = rows.map((r) => r.recent).sort((a, b) => a - b);
  const growths = rows.map((r) => r.growth).sort((a, b) => a - b);
  rows.forEach((r) => {
    r.score = Math.round(100 * (0.6 * pctile(levels, r.recent) + 0.4 * pctile(growths, r.growth)));
  });
  rows.sort((a, b) => b.score - a.score);
  const n = rows.length;
  rows.forEach((r, i) => {
    r.tier = i < n / 3 ? 'High' : i < (2 * n) / 3 ? 'Medium' : 'Low';
  });
  return rows;
}

// ── Repeat-offender risk ─────────────────────────────────────────────────────
// Additive, fully explainable score out of 100:
//   frequency  ≤40 — prior FIR count
//   recency    ≤25 — exponential decay over days since last offence
//   severity   ≤20 — share of heinous cases
//   network    ≤15 — distinct co-accused partners (Crime Links degree)
export function offenderRisk(cases, accused) {
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const byPerson = new Map();
  const caseCrew = new Map();
  accused.forEach((a) => {
    if (!a.person) return;
    if (!byPerson.has(a.person)) byPerson.set(a.person, { name: a.name, cases: new Set() });
    byPerson.get(a.person).cases.add(a.caseId);
    if (!caseCrew.has(a.caseId)) caseCrew.set(a.caseId, new Set());
    caseCrew.get(a.caseId).add(a.person);
  });

  const now = Date.now();
  const rows = [];
  byPerson.forEach((agg, person) => {
    const ids = [...agg.cases];
    if (ids.length < 2) return; // recidivism needs a history
    const tss = ids.map((id) => caseById.get(id)?.ts).filter(Number.isFinite);
    if (!tss.length) return;
    const lastTs = Math.max(...tss);
    const daysSince = Math.max(0, Math.round((now - lastTs) / 86400000));
    const heinousShare = ids.filter((id) => caseById.get(id)?.heinous).length / ids.length;
    const partners = new Set();
    ids.forEach((id) => caseCrew.get(id)?.forEach((p) => { if (p !== person) partners.add(p); }));

    const parts = {
      frequency: Math.min(40, (ids.length - 1) * 12),
      recency: Math.round(25 * Math.exp(-daysSince / 365)),
      severity: Math.round(20 * heinousShare),
      network: Math.min(15, partners.size * 3),
    };
    const score = parts.frequency + parts.recency + parts.severity + parts.network;
    rows.push({
      person,
      name: agg.name || person,
      firs: ids.length,
      daysSince,
      partners: partners.size,
      heinousShare,
      parts,
      score,
      tier: score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low',
    });
  });
  return rows.sort((a, b) => b.score - a.score);
}

// ── Anomaly detection ────────────────────────────────────────────────────────
// z-score of each of the last `recentWeeks` weeks against the trailing
// 12-week baseline, per crime head and per district.
export function detectAnomalies(cases, { z = 2, recentWeeks = 2 } = {}) {
  const groups = new Map();
  cases.forEach((c) => {
    [['head', c.head], ['district', c.district]].forEach(([kind, key]) => {
      if (key === 'Unknown') return;
      const k = `${kind}|${key}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c.ts);
    });
  });

  const alerts = [];
  groups.forEach((tsList, k) => {
    const [kind, label] = k.split('|');
    const series = weeklyCounts(tsList);
    if (series.length < 16) return;
    for (let i = Math.max(13, series.length - recentWeeks); i < series.length; i++) {
      const base = series.slice(i - 12, i).map((p) => p.value);
      const mean = base.reduce((s, v) => s + v, 0) / base.length;
      const sd = Math.max(0.8, Math.sqrt(base.reduce((s, v) => s + (v - mean) ** 2, 0) / base.length));
      const score = (series[i].value - mean) / sd;
      if (score >= z) {
        alerts.push({
          kind,
          label,
          week: series[i].label,
          actual: series[i].value,
          expected: Math.round(mean * 10) / 10,
          z: Math.round(score * 10) / 10,
        });
      }
    }
  });
  // Keep the strongest alert per group.
  const best = new Map();
  alerts.forEach((a) => {
    const k = `${a.kind}|${a.label}`;
    if (!best.has(k) || best.get(k).z < a.z) best.set(k, a);
  });
  return [...best.values()].sort((a, b) => b.z - a.z);
}
