// Control self-test. Run: node functions/rag/assurance.test.js
//
// The thing being tested here is unusual: a component whose whole job is to
// report on other components. That creates one specific way to fail that
// ordinary tests would never notice — a self-test that ALWAYS says green.
//
// A dashboard permanently reading "all controls operational" is worse than no
// dashboard, because it actively manufactures confidence. So the central test
// below breaks a real control by swapping its module out from under the
// self-test, and asserts the report turns red and names the right one. If
// someone later rewrites runSelfTest into something that reports success
// unconditionally, that test fails.
//
// It also pins the shape of each check, because the console's value is the
// evidence — "attack / expected / observed" is what makes a green tick
// something a person can audit rather than something they have to trust.
const path = require('path');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const freshAssurance = () => {
  delete require.cache[require.resolve('./assurance')];
  return require('./assurance');
};

// ── The healthy case ───────────────────────────────────────────────────────

const report = freshAssurance().runSelfTest();

check('every control reports', report.controls.length === 4);
check('all controls pass against the real modules', report.summary.pass,
  report.controls.filter((c) => !c.pass).map((c) => c.name).join(', '));
check('the summary counts every check', report.summary.checks === report.controls.reduce((n, c) => n + c.checks.length, 0));
check('passed + failed accounts for every check',
  report.summary.passed + report.summary.failed === report.summary.checks);
check('the run is timestamped', Number.isFinite(report.ranAt) && report.ranAt > 0);

for (const c of report.controls) {
  check(`${c.id}: names the module it exercises`, !!c.module && c.module.includes('.js'));
  check(`${c.id}: explains what the control does`, (c.what || '').length > 40);
  check(`${c.id}: has more than one check`, c.checks.length > 1);
  for (const k of c.checks) {
    check(`${c.id}: "${k.name.slice(0, 42)}" carries its evidence`,
      !!k.attack && !!k.expected && !!k.observed,
      JSON.stringify({ attack: !!k.attack, expected: !!k.expected, observed: !!k.observed }));
  }
}

// Each control must attack the thing it claims to protect, in both directions:
// a real attack that must be caught, and a benign case that must NOT be.
const audit = report.controls.find((c) => c.id === 'audit-integrity');
check('audit control tests the false-alarm direction too',
  audit.checks.some((k) => /not called tampering|verifies as intact/i.test(k.name)));
const ground = report.controls.find((c) => c.id === 'grounding');
check('grounding control tests the false-alarm direction too',
  ground.checks.some((k) => /not flagged|passes clean/i.test(k.name)));
const exp = report.controls.find((c) => c.id === 'export-control');
check('export control tests the false-alarm direction too',
  exp.checks.some((k) => /without friction|not flagged/i.test(k.name)));

// ── THE CENTRAL TEST: it must be able to go red ────────────────────────────
//
// Replace exportscreen with a version that waves everything through — the
// realistic regression, since a broken screen fails open rather than throwing.
// The self-test must notice.

const screenPath = require.resolve('./exportscreen');
const realScreen = require.cache[screenPath];

require.cache[screenPath] = {
  id: screenPath,
  filename: screenPath,
  loaded: true,
  exports: {
    screen: () => ({ needsReview: false, reasons: [], stats: { chars: 0, phones: 0, aadhaar: 0 } }),
    fingerprint: () => 'x'.repeat(64),
    textFromHtml: (s) => String(s || ''),
    summarise: () => 'no sensitive content detected',
    RULES: [], PHONE_LIMIT: 5, AADHAAR_LIMIT: 3,
  },
};

const broken = freshAssurance().runSelfTest();
const brokenExport = broken.controls.find((c) => c.id === 'export-control');

check('a control that silently fails open is reported RED', !broken.summary.pass);
check('and the right control is named', brokenExport && !brokenExport.pass);
check('the untouched controls still pass',
  broken.controls.filter((c) => c.id !== 'export-control').every((c) => c.pass));
check('the failing check says what it observed instead',
  brokenExport.checks.some((k) => !k.pass && /NOT HELD/.test(k.observed)),
  JSON.stringify(brokenExport.checks.filter((k) => !k.pass).map((k) => k.observed)));

// A neutered screen must NOT be able to pass by having no checks left to fail.
check('the broken control still ran its checks', brokenExport.checks.length > 1);

// ── A control that throws is a failure, never a silent omission ────────────

require.cache[screenPath] = {
  id: screenPath,
  filename: screenPath,
  loaded: true,
  exports: {
    screen: () => { throw new Error('module exploded'); },
    fingerprint: () => '', textFromHtml: (s) => s, summarise: () => '',
    RULES: [], PHONE_LIMIT: 5, AADHAAR_LIMIT: 3,
  },
};

const thrown = freshAssurance().runSelfTest();
const thrownExport = thrown.controls.find((c) => c.id === 'export-control');

check('a control that throws is still reported', thrown.controls.length === 4);
check('a control that throws is reported as failed', thrownExport && thrownExport.pass === false);
check('the error is surfaced, not swallowed', /module exploded/.test(thrownExport.error || ''));
check('an exploding control makes the whole run red', !thrown.summary.pass);

// Restore, and confirm the healthy result is reproducible rather than cached.
require.cache[screenPath] = realScreen;
const restored = freshAssurance().runSelfTest();
check('the report returns to green once the control is restored', restored.summary.pass);
check('the self-test is deterministic across runs',
  JSON.stringify(restored.controls.map((c) => [c.id, c.passed, c.failed]))
  === JSON.stringify(report.controls.map((c) => [c.id, c.passed, c.failed])));

// ── It must not depend on anything that can be unavailable ────────────────
//
// The moment someone asks whether the controls are still standing is usually
// the moment something else is broken, so this must not itself need Stratus,
// ZCQL or a model provider.
const src = require('fs').readFileSync(path.join(__dirname, 'assurance.js'), 'utf8');
check('the self-test makes no network or datastore calls',
  !/catalystSDK|stratus\(|zcql|fetch\(|require\('axios'\)/.test(src));
check('the self-test is synchronous (no awaits to hang on)', !/\bawait\b/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
