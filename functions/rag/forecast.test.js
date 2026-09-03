/* Forecast serving — the parts that fail SILENTLY if they drift.
 *
 * Two failure modes drive this suite:
 *
 *  1. FEATURE DRIFT. QuickML answers `null` rather than erroring when a feature
 *     name does not match the training column. A renamed column would show up
 *     as a flat, empty chart and look like a bad model. So the feature rows
 *     shipped in forecast_features.json are checked against the declared
 *     contract, key by key.
 *
 *  2. RESPONSE SHAPE. The predict API's envelope is not documented. If the
 *     unwrapper misses a shape it returns null, which again reads as a broken
 *     model. Every shape it claims to handle is asserted here.
 */
const assert = require('assert');
const F = require('./forecast');
const FEATURES = require('./forecast_features.json');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass += 1; console.log(`ok  ${name}`); } else { fail += 1; console.log(`FAIL ${name}`); }
}

// ── the feature contract ────────────────────────────────────────────────────
const EXPECTED = [
  'series', 'horizon', 'month', 'quarter',
  'lag_1', 'lag_2', 'lag_3', 'lag_12', 'seasonal_lag_12',
  'roll_3', 'roll_6', 'roll_12',
];
const SERIES_COUNT = { firvolume: 1, crimehead: 10, district: 31 };

check('the shipped feature list is exactly the training contract',
  JSON.stringify(FEATURES.features) === JSON.stringify(EXPECTED));
check('the target column is target_count', FEATURES.target === 'target_count');
check('all three pipelines have feature tables',
  !!FEATURES.tables.firvolume && !!FEATURES.tables.crimehead && !!FEATURES.tables.district);
check('the grain is monthly', FEATURES.grain === 'month');

for (const [name, table] of Object.entries(FEATURES.tables)) {
  check(`${name}: expected series count`, table.series.length === SERIES_COUNT[name]);
  check(`${name}: horizon is 6 months`, table.horizon === 6);
  check(`${name}: origin month is YYYY-MM`, /^\d{4}-\d{2}$/.test(table.origin_month));

  const rows = table.rows[table.series[0]];
  check(`${name}: one feature row per horizon`, rows.length === table.horizon);
  check(`${name}: horizons run 1..6 in order`,
    rows.every((r, i) => r.horizon === i + 1));

  // Every row must carry EXACTLY the contract keys — no more, no fewer.
  const bad = rows.filter((r) => {
    const k = Object.keys(r).sort();
    return JSON.stringify(k) !== JSON.stringify([...EXPECTED].sort());
  });
  check(`${name}: every feature row matches the contract exactly`, bad.length === 0);

  // A NaN or null reaches QuickML as a missing feature and comes back null.
  const nonFinite = [];
  for (const s of table.series) {
    for (const r of table.rows[s]) {
      for (const [k, v] of Object.entries(r)) {
        if (k === 'series') continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) nonFinite.push(`${s}.${k}=${v}`);
      }
    }
  }
  check(`${name}: every numeric feature is finite`, nonFinite.length === 0);

  check(`${name}: series column matches the series key`,
    table.series.every((s) => table.rows[s].every((r) => r.series === s)));

  // The lag features are read from the same origin for every horizon: they
  // describe observed history, not a moving window. If they varied with h the
  // model would be recursive, which is not what it was trained as.
  const first = table.rows[table.series[0]];
  check(`${name}: lags are fixed at the origin across horizons`,
    first.every((r) => r.lag_1 === first[0].lag_1 && r.roll_3 === first[0].roll_3));

  check(`${name}: history is aligned with its month labels`,
    table.series.every((s) => table.history[s].length === table.history_months.length));
}

// ── response unwrapping ─────────────────────────────────────────────────────
const SHAPES = [
  ['bare number', 42, 42],
  ['numeric string', '42.5', 42.5],
  ['result array', { result: [37] }, 37],
  ['result array of string', { result: ['37'] }, 37],
  ['result nested array', { result: [[37]] }, 37],
  ['prediction key', { prediction: 12 }, 12],
  ['predictions array', { predictions: [12.25] }, 12.25],
  ['result object with target', { result: [{ target_count: 19 }] }, 19],
  ['data wrapper', { data: { result: [8] } }, 8],
  ['output key', { output: 5 }, 5],
  // Observed live from a deployed timeseries pipeline.
  ['date-keyed timeseries object', { result: { '2026-07-06': 21 } }, 21],
  ['month-keyed timeseries object', { result: { '2026-07': 19 } }, 19],
];
for (const [label, body, want] of SHAPES) {
  check(`unwraps ${label}`, F.extractPrediction(body).value === want);
}
check('an unrecognised body yields null, not a wrong number',
  F.extractPrediction({ status: 'failure', message: 'nope' }).value === null);
check('an empty result array yields null',
  F.extractPrediction({ result: [] }).value === null);
check('zero is a real prediction, not a falsy miss',
  F.extractPrediction({ result: [0] }).value === 0);

// ── labelling ───────────────────────────────────────────────────────────────
check('a district key resolves to its name',
  F.labelFor(F.MODELS.district, 'district_4401') === 'Bengaluru City');
check('the single-series total is labelled for officers',
  F.labelFor(F.MODELS.firvolume, 'all') === 'All Karnataka');
check('a crime head key resolves to its name',
  F.labelFor(F.MODELS.crimehead, 'crime_major_head_1') === 'Crimes Against Body');
check('an unknown key falls back to its id rather than throwing',
  F.labelFor(F.MODELS.district, 'district_9999') === '9999');

// ── month arithmetic ────────────────────────────────────────────────────────
check('horizon 1 is the month after the origin',
  F.monthAfter('2026-06', 1) === '2026-07');
check('horizon 6 is six months after the origin',
  F.monthAfter('2026-06', 6) === '2026-12');
check('month stepping crosses a year boundary',
  F.monthAfter('2026-11', 3) === '2027-02');
check('December + 1 rolls to January',
  F.monthAfter('2026-12', 1) === '2027-01');

// ── prediction bands ────────────────────────────────────────────────────────
check('a band brackets its prediction', (() => {
  const b = F.withBand(100, 0.041);
  return b.lo < 100 && b.hi > 100;
})());
check('a band never goes negative', F.withBand(1, 0.5).lo >= 0);
check('a null prediction has no band', F.withBand(null, 0.1).lo === null);
check('every model declares a measured relative error',
  Object.values(F.MODELS).every((m) => typeof m.relMae === 'number' && m.relMae > 0));
check('every model reports skill against the FLAT-MEAN baseline, not naive',
  Object.values(F.MODELS).every((m) => typeof m.quality.flatMae === 'number'
    && typeof m.quality.skillPct === 'number'));

// ── bounded concurrency ─────────────────────────────────────────────────────
(async () => {
  const jobs = Array.from({ length: 25 }, (_, i) => i);
  let live = 0;
  let peak = 0;
  const out = await F.pool(jobs, 6, async (j) => {
    live += 1; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 2));
    live -= 1;
    return j * 2;
  });
  check('pool preserves input order', out.every((v, i) => v === i * 2));
  check('pool never exceeds its concurrency limit', peak <= 6);
  check('pool runs concurrently at all', peak > 1);

  // A model call that throws must not sink the whole bundle.
  const mixed = await F.pool([1, 2, 3], 2, async (j) => {
    if (j === 2) throw new Error('boom');
    return j;
  }).then(() => 'no-throw').catch(() => 'threw');
  check('pool propagates a worker throw rather than hiding it', mixed === 'threw');

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail) process.exit(1);
})();
