/* Live crime-volume forecasts, served from the deployed QuickML models.
 *
 * THREE PIPELINES, 42 SERIES
 *
 * The Forecasts page shows three cards — force-wide FIR volume, volume for one
 * crime head, volume for one district — and there is one QuickML pipeline
 * behind each:
 *
 *   firvolume    1 series    the force-wide monthly total
 *   crimehead   10 series    one row per (crime head, horizon)
 *   district    31 series    one row per (district,   horizon)
 *
 * All three are direct multi-horizon REGRESSION models: the series is a
 * feature, so one model covers every series in its table. See
 * ksp/ml/export_forecast_data.py for the table shape and why these are not
 * QuickML's per-target forecasting pipelines.
 *
 * MONTHLY, AND WHY IT IS NOT A DETAIL
 *
 * Weekly, every one of these lost to a flat per-series average. Counts carry
 * Poisson noise growing as sqrt(level) while the seasonal signal grows with the
 * level, so at 5 FIRs per district-week the signal sits underneath the noise.
 * Monthly buckets lift the level ~4.3x and the signal-to-noise ~2x, which is
 * the whole difference between these models and a flat line.
 *
 * COST, AND WHY THERE IS A CACHE IN OBJECT STORAGE
 *
 * QuickML bills per prediction call: 500/month free, then $0.0025. A full
 * refresh is 42 series x 6 horizons = 252 calls. Rendering that per page view
 * would burn the monthly allowance in a sitting, and an in-memory cache dies
 * with the container. So the assembled bundle lives in Stratus and the route
 * normally serves a blob read: the numbers come from the models, but they are
 * paid for once.
 *
 * The dataset is static, so a cached bundle is not stale — it is keyed by the
 * origin month, and recomputed only when the data moves.
 */

const FEATURES = require('./forecast_features.json');
const MASTERS = require('./masters.json');

const ORG = process.env.RAG_ORG || '60073599957';
const PREDICT_URL =
  process.env.QUICKML_PREDICT_URL ||
  'https://api.catalyst.zoho.in/quickml/v1/project/49826000000024269/endpoints/predict';

/* The three pipelines, and how each maps a series key to a name an officer
 * reads.
 *
 * `keyEnv` names an env var rather than holding the endpoint key: a leaked key
 * is then one model rather than all of them.
 *
 * `quality` is measured OFFLINE, in ksp/ml, by pooled rolling-origin
 * validation against the honest baseline — each series' own historical
 * average. Naive and seasonal-naive were the wrong bar: for noisy counts the
 * mean beats both, so a model scored only against them can look strong while
 * adding nothing. `skillPct` is the improvement over that average.
 *
 * These are NOT the numbers QuickML's console reports. The console scores a
 * random split, and on a table of lag features adjacent rows share history, so
 * its metric is optimistic by construction. The UI shows these because they
 * are the ones that survive contact with a month the model has never seen. */
const MODELS = {
  firvolume: {
    keyEnv: 'QUICKML_KEY_FIRVOLUME',
    prefix: null,                 // single series, no id to strip
    master: null,
    label: 'FIR volume forecast',
    quality: { mae: 31.6, mape: 4.1, skillPct: 65, flatMae: 91.2, unit: 'FIRs/month' },
    relMae: 0.041,
  },
  crimehead: {
    keyEnv: 'QUICKML_KEY_CRIMEHEAD',
    prefix: 'crime_major_head',
    master: 'crimeHeads',
    label: 'Forecast by crime head',
    quality: { mae: 9.1, mape: 15.6, skillPct: 12, flatMae: 10.3, unit: 'FIRs/month' },
    relMae: 0.116,
  },
  district: {
    keyEnv: 'QUICKML_KEY_DISTRICT',
    prefix: 'district',
    master: 'districts',
    label: 'Forecast by district',
    quality: { mae: 4.3, mape: 22.0, skillPct: 7, flatMae: 4.6, unit: 'FIRs/month' },
    relMae: 0.172,
  },
};

/* A QuickML regression endpoint returns a point estimate and nothing else, so
   the chart's interval has to come from measured error rather than from the
   response. `relMae` above is each model's held-out mean absolute error
   relative to its own level.

   MAE -> sigma for a roughly normal error is MAE * sqrt(pi/2); 95% is 1.96
   sigma. Bands scale with the predicted value, so a large district gets a
   wider band than a small one, and never narrow below +/-1 FIR, which is the
   resolution of a count. */
const BAND = 1.96 * 1.2533;
function withBand(value, rel) {
  if (value === null) return { lo: null, hi: null };
  const half = Math.max(1, BAND * rel * value);
  return {
    lo: Math.max(0, Math.round((value - half) * 10) / 10),
    hi: Math.round((value + half) * 10) / 10,
  };
}

const CACHE_KEY = () => `forecast/bundle-v3-${FEATURES.tables.firvolume.origin_month}.json`;

/* A series key ("district_4401") -> the name on screen ("Bengaluru City"). */
function labelFor(model, seriesKey) {
  if (!model.prefix) return 'All Karnataka';
  const id = seriesKey.slice(model.prefix.length + 1);
  return (MASTERS[model.master] && MASTERS[model.master][id]) || id;
}

/* QuickML answers in more than one shape depending on the pipeline, and a
   wrong guess here reads as a broken model rather than a parsing bug. A
   regression endpoint returns {result:[n]}; the timeseries pipelines return
   {result:{"2026-07-01":n}}, a DATE-KEYED OBJECT. Both are unwrapped, and
   anything unrecognised returns null so the caller can report it honestly. */
function extractPrediction(body) {
  const seen = [];
  const dig = (v, depth) => {
    if (depth > 5 || v === null || v === undefined) return null;
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
      // Date-keyed object from a timeseries pipeline: {"2026-07-01": 21}
      const keys = Object.keys(v);
      if (keys.length && keys.every((k) => /^\d{4}-\d{2}(-\d{2})?$/.test(k))) {
        return dig(v[keys[0]], depth + 1);
      }
      seen.push(keys.join(','));
    }
    return null;
  };
  return { value: dig(body, 0), shape: seen[0] || typeof body };
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
  if (!r.ok) throw new Error(`quickml ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return extractPrediction(body);
}

/* Run `jobs` with bounded concurrency. Sequentially, 252 calls outlive the
   request; unbounded, they arrive as a burst the endpoint rate-limits. */
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

const monthAfter = (ym, n) => {
  const t = Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5, 7)) - 1) + n;
  return `${String(Math.floor(t / 12)).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}`;
};

/* Predict every (series, horizon) in one table. Errors are reported rather
   than swallowed — a chart drawn from a silently-failed model is worse than a
   chart that says it failed. */
async function predictTable(name, token) {
  const model = MODELS[name];
  const endpointKey = process.env[model.keyEnv];
  if (!endpointKey) throw new Error(`${model.keyEnv} is not configured`);

  const table = FEATURES.tables[name];
  const jobs = [];
  for (const s of table.series) for (const row of table.rows[s]) jobs.push({ s, row });

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
  for (const s of table.series) {
    series[s] = {
      key: s,
      label: labelFor(model, s),
      forecast: table.rows[s].map((row) => {
        const value = results[i++];
        return {
          month: monthAfter(table.origin_month, row.horizon),
          horizon: row.horizon,
          value,
          ...withBand(value, model.relMae),
        };
      }),
      history: (table.history[s] || []).map((v, j) => ({
        month: table.history_months[j], value: v,
      })),
    };
  }
  return { series, errors };
}

/* The whole dashboard in one object: three models, every series. */
async function buildBundle(token) {
  const [fv, ch, di] = await Promise.all([
    predictTable('firvolume', token),
    predictTable('crimehead', token),
    predictTable('district', token),
  ]);

  const t = FEATURES.tables.firvolume;
  const totalSeries = fv.series[t.series[0]];
  const out = {
    version: 3,
    grain: 'month',
    origin_month: t.origin_month,
    horizon: t.horizon,
    generated_at: new Date().toISOString(),
    source: 'quickml',
    total: {
      label: MODELS.firvolume.label,
      quality: MODELS.firvolume.quality,
      forecast: totalSeries.forecast,
      history: totalSeries.history,
    },
    crimehead: { label: MODELS.crimehead.label, quality: MODELS.crimehead.quality,
      series: ch.series },
    district: { label: MODELS.district.label, quality: MODELS.district.quality,
      series: di.series },
    errors: [...fv.errors, ...ch.errors, ...di.errors].slice(0, 20),
    billedCalls: (t.series.length + FEATURES.tables.crimehead.series.length
      + FEATURES.tables.district.series.length) * t.horizon,
  };
  return out;
}

/* Stratus I/O stays in index.js, which owns streamToString and the bucket. */
module.exports = {
  MODELS, FEATURES, CACHE_KEY,
  extractPrediction, predictTable, buildBundle, pool, labelFor, monthAfter, withBand,
};
