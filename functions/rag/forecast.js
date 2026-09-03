/* Live crime-volume forecasts, served from the deployed QuickML models.
 *
 * WHAT THE DASHBOARD ASKS FOR, AND WHAT ACTUALLY RUNS
 *
 * The Forecasts page shows three cards: force-wide FIR volume, volume for one
 * crime head, volume for one district. Those are 42 different series, but
 * there are only TWO QuickML pipelines behind them:
 *
 *   crimehead   10 series   one row per (crime head, horizon)
 *   district    31 series   one row per (district,   horizon)
 *
 * Both are direct multi-horizon REGRESSION models: the series is a feature,
 * so one model covers every series in its table. See
 * ksp/ml/export_forecast_data.py for the table shape and why it is not one of
 * QuickML's per-target forecasting pipelines.
 *
 * The force-wide total has NO model of its own. It is the sum of the 31
 * district forecasts. Backtested leak-free, a dedicated total model scored
 * between +0.7% and +19.5% against the better of naive and seasonal-naive
 * depending on which learner was picked, and went negative at long horizons;
 * the bottom-up sum held +12% to +19% for every tree learner. It also costs
 * nothing extra — the district card already needs those same predictions.
 *
 * COST, AND WHY THERE IS A CACHE IN OBJECT STORAGE
 *
 * QuickML bills per prediction call: 500/month free, then $0.0025. A full
 * refresh is 41 series x 13 horizons = 533 calls. Rendering that per page view
 * would burn the monthly allowance in one sitting, and an in-memory cache dies
 * with the container. So the assembled bundle lives in Stratus and the route
 * normally serves a blob read: the numbers come from the models, but they are
 * paid for once.
 *
 * The dataset is static, so a cached bundle is not stale — it is keyed by the
 * origin week and the feature-table version, and recomputed only when either
 * moves.
 */

const FEATURES = require('./forecast_features.json');
const MASTERS = require('./masters.json');

const ORG = process.env.RAG_ORG || '60073599957';
const PREDICT_URL =
  process.env.QUICKML_PREDICT_URL ||
  'https://api.catalyst.zoho.in/quickml/v1/project/49826000000024269/endpoints/predict';

/* The two pipelines, and how each maps a series key to a name an officer reads.
 *
 * `keyEnv` names an env var rather than holding the endpoint key: a leaked key
 * is then one model rather than all of them.
 *
 * `quality` is measured OFFLINE, in ksp/ml, on a held-out time split — train
 * only on rows whose target falls before the cutoff. It is not the number
 * QuickML's console reports. The console scores a RANDOM split, and on a table
 * of lag features adjacent rows share history, so its metric is optimistic by
 * construction. The UI shows these figures because they are the ones that
 * survive contact with a week the model has never seen. */
const MODELS = {
  crimehead: {
    keyEnv: 'QUICKML_KEY_CRIMEHEAD',
    prefix: 'crime_major_head',
    master: 'crimeHeads',
    label: 'Forecast by crime head',
    quality: { mae: 3.9, mape: 34, skillPct: 17, baselineMae: 4.69, unit: 'FIRs/week' },
  },
  district: {
    keyEnv: 'QUICKML_KEY_DISTRICT',
    prefix: 'district',
    master: 'districts',
    label: 'Forecast by district',
    quality: { mae: 2.1, mape: 49, skillPct: 23, baselineMae: 2.69, unit: 'FIRs/week' },
  },
};

// The force-wide card, derived rather than modelled.
const TOTAL_QUALITY = {
  mae: 13.9, mape: 7.8, skillPct: 15, baselineMae: 16.33, unit: 'FIRs/week',
  derivation: 'sum of the 31 district forecasts',
};

/* A QuickML regression endpoint returns a point estimate and nothing else, so
   the chart's interval has to come from measured error rather than from the
   response. These are held-out mean absolute errors relative to each table's
   own level (ksp/ml backtest, held-out time split).

   They are flat across the horizon — 0.20 at week 1 and 0.20 at week 13 —
   which is a property of the direct design: every horizon is predicted from
   the same observed history, so nothing compounds the way a recursive
   forecast does. One number per model is therefore not a simplification. */
const RELATIVE_MAE = { crimehead: 0.205, district: 0.345, total: 0.081 };

/* MAE -> sigma for a roughly normal error is MAE * sqrt(pi/2); 95% is 1.96
   sigma. Bands are proportional to the predicted value so a large district
   gets a wider band than a small one, and never narrower than +/-1 FIR, which
   is the resolution of a count. */
const BAND = 1.96 * 1.2533;
function withBand(value, rel) {
  if (value === null) return { lo: null, hi: null };
  const half = Math.max(1, BAND * rel * value);
  return {
    lo: Math.max(0, Math.round((value - half) * 10) / 10),
    hi: Math.round((value + half) * 10) / 10,
  };
}

const CACHE_KEY = () => `forecast/bundle-v2-${FEATURES.tables.district.origin_week}.json`;

/* A series key ("district_4401") -> the name on screen ("Bengaluru City").
   The id is kept alongside so the UI can match a selection either way. */
function labelFor(model, seriesKey) {
  const id = seriesKey.slice(model.prefix.length + 1);
  return (MASTERS[model.master] && MASTERS[model.master][id]) || id;
}

/* QuickML answers in more than one shape depending on the pipeline, and a
   wrong guess here reads as a broken model rather than a parsing bug. Every
   documented and observed shape is unwrapped to a number, and anything else
   returns null so the caller can report it honestly. */
function extractPrediction(body) {
  const seen = [];
  const dig = (v, depth) => {
    if (depth > 4 || v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    if (Array.isArray(v)) return v.length ? dig(v[0], depth + 1) : null;
    if (typeof v === 'object') {
      for (const k of ['result', 'prediction', 'predictions', 'output', 'data',
        'target_count', 'value', 'predicted_value']) {
        if (k in v) {
          const got = dig(v[k], depth + 1);
          if (got !== null) return got;
        }
      }
      seen.push(Object.keys(v).join(','));
    }
    return null;
  };
  const n = dig(body, 0);
  return { value: n, shape: seen[0] || typeof body };
}

async function callQuickML(endpointKey, row, token) {
  const r = await fetch(PREDICT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-QUICKML-ENDPOINT-KEY': endpointKey,
      Authorization: `Zoho-oauthtoken ${token}`,
      'CATALYST-ORG': ORG,
      Environment: process.env.QUICKML_ENV || 'Development',
    },
    body: JSON.stringify({ data: row }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`quickml ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return extractPrediction(body);
}

/* Run `jobs` with bounded concurrency.
   Sequentially, 533 calls take minutes and outlive the request; unbounded,
   they arrive as a burst the endpoint rate-limits. Six at a time is the
   compromise that has held. */
async function pool(jobs, limit, worker) {
  const out = new Array(jobs.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      out[i] = await worker(jobs[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

const weekAfter = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10);
};

/* Predict every (series, horizon) in one table. Returns the series map plus
   the errors, which are reported rather than swallowed — a chart drawn from a
   silently-failed model is worse than a chart that says it failed. */
async function predictTable(name, token, only) {
  const model = MODELS[name];
  const endpointKey = process.env[model.keyEnv];
  if (!endpointKey) throw new Error(`${model.keyEnv} is not configured`);

  const table = FEATURES.tables[name];
  const keys = only ? table.series.filter((s) => only.includes(s)) : table.series;
  const jobs = [];
  for (const s of keys) for (const row of table.rows[s]) jobs.push({ s, row });

  const errors = [];
  const results = await pool(jobs, 6, async ({ s, row }) => {
    try {
      const { value, shape } = await callQuickML(endpointKey, row, token);
      if (value === null) {
        errors.push(`${s} h${row.horizon}: unrecognised response (${shape})`);
        return null;
      }
      return Math.max(0, Math.round(value * 10) / 10);
    } catch (e) {
      errors.push(`${s} h${row.horizon}: ${String(e.message).slice(0, 120)}`);
      return null;
    }
  });

  const series = {};
  let i = 0;
  for (const s of keys) {
    const points = table.rows[s].map((row) => {
      const value = results[i++];
      return {
        week: weekAfter(table.origin_week, row.horizon),
        horizon: row.horizon,
        value,
        ...withBand(value, RELATIVE_MAE[name]),
      };
    });
    series[s] = {
      key: s,
      label: labelFor(model, s),
      forecast: points,
      history: (table.history[s] || []).map((v, j) => ({
        week: table.history_weeks[j], value: v,
      })),
    };
  }
  return { series, errors };
}

/* The whole dashboard in one object: both models, every series, and the
   derived force-wide total. */
async function buildBundle(token) {
  const [ch, di] = await Promise.all([
    predictTable('crimehead', token),
    predictTable('district', token),
  ]);

  // Force-wide total: sum the districts at each horizon. A horizon where any
  // district failed is left null rather than reported as a smaller total.
  const dTable = FEATURES.tables.district;
  const total = [];
  for (let h = 1; h <= dTable.horizon; h += 1) {
    let sum = 0;
    let complete = true;
    for (const s of dTable.series) {
      const p = di.series[s].forecast.find((x) => x.horizon === h);
      if (!p || p.value === null) { complete = false; break; }
      sum += p.value;
    }
    const value = complete ? Math.round(sum) : null;
    total.push({
      week: weekAfter(dTable.origin_week, h),
      horizon: h,
      value,
      ...withBand(value, RELATIVE_MAE.total),
    });
  }
  const totalHistory = dTable.history_weeks.map((w, j) => ({
    week: w,
    value: dTable.series.reduce((a, s) => a + (dTable.history[s][j] || 0), 0),
  }));

  return {
    version: 2,
    origin_week: dTable.origin_week,
    horizon: dTable.horizon,
    generated_at: new Date().toISOString(),
    source: 'quickml',
    total: { label: 'All Karnataka', forecast: total, history: totalHistory,
      quality: TOTAL_QUALITY },
    crimehead: { label: MODELS.crimehead.label, quality: MODELS.crimehead.quality,
      series: ch.series },
    district: { label: MODELS.district.label, quality: MODELS.district.quality,
      series: di.series },
    errors: [...ch.errors, ...di.errors].slice(0, 20),
    billedCalls: Object.keys(ch.series).length * dTable.horizon
      + Object.keys(di.series).length * dTable.horizon,
  };
}

/* Stratus I/O stays in index.js, which owns streamToString and the bucket. */
module.exports = {
  MODELS, TOTAL_QUALITY, FEATURES, CACHE_KEY, RELATIVE_MAE, withBand,
  extractPrediction, predictTable, buildBundle, pool, labelFor, weekAfter,
};
