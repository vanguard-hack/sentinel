// The benchmark's own tests. Run: node functions/rag/bench.test.js
//
// Two things need pinning here, and they are different things.
//
// FIRST, the ground truth. The benchmark's whole claim is that its expected
// values are computed from the record snapshot rather than typed into a file,
// so the parser that produces them has to be right. A parser that silently
// dropped half the records would make every downstream percentage look fine
// while measuring a quarter of the data.
//
// SECOND, and more important: that the gates can actually FAIL. A benchmark
// that has never gone red is indistinguishable from one whose assertions do
// not run, and the failure is invisible — green ticks either way. So each
// control is broken on purpose via --inject-fault and the exit code is
// asserted. If someone later refactors a gate into a no-op, this is what
// notices.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const store = require('./bench/store');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const RUN = path.join(__dirname, 'bench', 'run.js');
const runBench = (args = []) => {
  try {
    const stdout = execFileSync(process.execPath, [RUN, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || '') };
  }
};

// ── The record store ───────────────────────────────────────────────────────

check('the record source is present', store.available(),
  `expected ${store.CSV_PATH} — the dataset is generated, not committed. `
  + 'Run ksp/fir/generate_fir_dataset.py; the CI workflow has the exact invocation.');

const S = store.stats();
// Asserted against the CSV rather than a literal: the dataset is regenerated
// at different sizes (N_CASES), and a hardcoded count would fail on every
// regeneration while telling nobody anything useful.
const csvRows = fs.readFileSync(store.CSV_PATH, 'utf8').trimEnd().split('\n').length - 1;
check('every record in the source CSV parsed', S.rows === csvRows, `parsed ${S.rows} of ${csvRows}`);
check('  and there are enough of them to measure anything', S.rows >= 2000, String(S.rows));
check('districts were resolved', S.districts === 31, String(S.districts));
check('crime sub-heads were resolved', S.crimeSubHeads === 31, String(S.crimeSubHeads));

const first = store.all()[0];
check('a record carries the fields the benchmark filters on',
  !!(first.crimeNo && first.district && first.crimeSubHead && first.briefFacts),
  JSON.stringify(Object.keys(first)));
check('coordinates parsed as numbers', typeof first.latitude === 'number');
check('the year is derived for date filtering', first.year >= 2023 && first.year <= 2026);

// Counts must agree with a completely independent pass over the file, or the
// "ground truth is computed" claim is worth nothing.
// An independent pass over the CSV: count the Mysuru stations from masters and
// tally rows against them, so the store's own resolution is not both the thing
// under test and the yardstick.
const masters = require('./masters.json');
const mysuruId = Object.entries(masters.districts).find(([, n]) => n === 'Mysuru')[0];
const mysuruStations = new Set(Object.entries(masters.units)
  .filter(([, u]) => String(u.district) === String(mysuruId)).map(([id]) => id));
const raw = fs.readFileSync(store.CSV_PATH, 'utf8').trimEnd().split('\n').slice(1);
const rawMysuru = raw.filter((l) => mysuruStations.has(l.split(',')[5])).length;
check('a computed count matches a raw scan of the export',
  store.count({ district: 'Mysuru' }) === rawMysuru,
  `store ${store.count({ district: 'Mysuru' })} vs raw ${rawMysuru}`);

// ── The planted gap has to be a real gap ───────────────────────────────────
//
// This is the check that keeps the abstention test honest. If emptyPair()
// returned a combination that actually has records, the benchmark would be
// asking the assistant to refuse an answerable question.
const gap = store.emptyPair();
check('a genuinely empty district/crime pair was found', !!gap, 'none found');
check('  and it really is empty', gap && store.count({ district: gap.district, crimeSubHead: gap.crimeSubHead }) === 0);
check('  while both halves of it exist on their own',
  gap && store.count({ district: gap.district }) > 0 && store.count({ crimeSubHead: gap.crimeSubHead }) > 0,
  'a gap made of a district or crime type that does not exist would be a trick question, not a test');

const pop = store.populatedPair();
check('a populated pair was found for the accuracy check', !!pop);
check('  and its count is what the store reports',
  pop && store.count({ district: pop.district, crimeSubHead: pop.crimeSubHead }) === pop.n);

// ── A clean run ────────────────────────────────────────────────────────────

const clean = runBench();
check('a clean run exits zero', clean.code === 0, `exit ${clean.code}`);
check('  and reports the dataset it measured', new RegExp(`${S.rows} FIRs`).test(clean.stdout), clean.stdout.split('\n')[1]);
check('  and writes the report', fs.existsSync(path.join(__dirname, '..', '..', 'docs', 'BENCHMARK.md')));

const report = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'BENCHMARK.md'), 'utf8');
check('the report states the results table', /\| Metric \| What it measures \| Result \|/.test(report));
check('the report says ground truth is computed, not typed',
  /computed, never typed/i.test(report));
check('the report is honest that injection detection is defeatable',
  /paraphrase/i.test(report));
check('the report names the untested end-to-end section rather than omitting it',
  /End-to-end answer accuracy/.test(report));

// ── Every gate must be able to go red ──────────────────────────────────────
//
// The meta-test. Break one control, watch the matching gate fail, confirm the
// process exits non-zero so CI would stop.
const FAULTS = [
  ['clearance', /Clearance leakage/],
  ['validator', /Unsafe query refusal/],
  ['grounding', /Fabricated record detection/],
  ['screen', /Export screen recall/],
  ['guard', /Officers wrongly refused/],
];
for (const [fault, expected] of FAULTS) {
  const r = runBench(['--inject-fault', fault]);
  check(`breaking ${fault} fails the build`, r.code === 1, `exit ${r.code}`);
  const failedLines = r.stdout.split('\n').filter((l) => l.startsWith('FAIL'));
  check(`  and it is the ${fault} gate that reports it`,
    failedLines.some((l) => expected.test(l)),
    JSON.stringify(failedLines));
  check(`  and the failure names the offending case`,
    /·/.test(r.stdout), 'no example failures printed');
}

check('an unknown fault name is rejected rather than silently ignored',
  runBench(['--inject-fault', 'nonsense']).code === 2);

// A fault run must not overwrite the committed report with its fiction. This
// caught a real defect: the first version of these tests left a BENCHMARK.md
// on disk reporting that officers were refused 100% of the time.
const before = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'BENCHMARK.md'), 'utf8');
const faultRun = runBench(['--inject-fault', 'guard']);
const after = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'BENCHMARK.md'), 'utf8');
check('a fault run leaves the committed report untouched', before === after,
  'the sabotaged run overwrote docs/BENCHMARK.md');
check('  and says so rather than failing silently',
  /report NOT written/.test(faultRun.stdout));

// ── The end-to-end section degrades honestly ───────────────────────────────
//
// With no --api it must report "not run", never a passing score. A benchmark
// that shows 100% for a section it skipped is worse than one that shows
// nothing.
check('the end-to-end section reports "not run" without --api',
  /End-to-end answer accuracy\s+not run/.test(clean.stdout), 'expected an explicit not-run line');
check('  and does not claim a percentage for it',
  !/End-to-end answer accuracy\s+\d+\.\d%/.test(clean.stdout));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
