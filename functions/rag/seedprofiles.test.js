// Seed profiles → obligations. Run: node functions/rag/seedprofiles.test.js
//
// The seeder exists so the Action Queue has something to count on a deployment
// where nobody has opened a diary. That only works if each profile actually
// produces the obligation it was designed to produce — and the failure mode is
// silent: seed the data, open the page, find it empty, and have no idea whether
// the seeder or the engine is at fault.
//
// So this builds the same records the seeder builds and runs them through the
// real obligation engine, asserting each profile lands where it was aimed. It
// is the only part of the seeder that can be tested without a live Stratus
// bucket, and it is the part that would actually break.
const statutory = require('./statutory');
const KB = require('./legal_kb.json');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-01T09:00:00.000Z');
const at = (d) => NOW - d * DAY;

// Mirrors what handleInvestigationSeed writes, including the shapes
// appendInvestigationEntry adds (id, ts, ioName).
function buildFromProfile(p, i = 0) {
  const rec = {
    caseMasterId: `CM-${i}`,
    crimeNo: `4${i}2/2026`,
    ioName: 'Seed Officer',
    station: '101',
    status: 'Under Investigation',
    sections: '379, 457',
    registeredDate: new Date(at(120)).toISOString().slice(0, 10),
    lastDiaryDate: new Date(at(p.lastDiaryDaysAgo || 2)).toISOString().slice(0, 10),
    seeded: true,
    diaryEntries: [{ id: 'd1', ts: at(p.lastDiaryDaysAgo || 2), seeded: true }],
    statements: Array.from({ length: p.statements || 0 }, (_, k) => ({ id: `s${k}`, ts: at(3), seeded: true })),
    evidence: (p.evidence || []).map((e, k) => ({
      id: `e${k}`, description: e.description, type: e.type,
      seizureMemoRef: e.seizureMemoRef || '', fslStatus: 'Not sent', ts: at(e.daysAgo), seeded: true,
    })),
    persons: (p.persons || []).map((q, k) => ({
      id: `p${k}`, ...q, ts: at(p.arrestedDaysAgo || 5), seeded: true,
    })),
    timeline: p.arrestedDaysAgo
      ? [{ id: 't1', type: 'Arrest', detail: 'Accused arrested.', ts: at(p.arrestedDaysAgo), seeded: true }]
      : [],
    findings: [],
  };
  return rec;
}

const PROFILES = {
  'custody-critical': { arrestedDaysAgo: 47, persons: [{ name: 'Ramesh Kumar', role: 'Accused', status: 'Arrested' }], statements: 0 },
  'custody-overdue': { arrestedDaysAgo: 64, persons: [{ name: 'Suresh Naik', role: 'Accused', status: 'Arrested' }], statements: 1 },
  'cctv-lapsing': {
    evidence: [{ description: 'Shop CCTV, 22:00-23:00, DVR at premises', type: 'Digital', daysAgo: 26 }],
    persons: [{ name: 'Unknown accused', role: 'Accused', status: 'At large' }], statements: 1,
  },
  'quiet-case': { lastDiaryDaysAgo: 96, persons: [{ name: 'Mahesh Gowda', role: 'Suspect', status: 'On bail' }], statements: 2 },
  'clean-case': {
    persons: [{ name: 'Prakash Rao', role: 'Accused', status: 'On bail' }], statements: 2,
    evidence: [{ description: 'Recovered crowbar', type: 'Physical', daysAgo: 4, seizureMemoRef: 'SM/2026/118' }],
  },
};

const obligationsOf = (key) =>
  statutory.obligationsFor(buildFromProfile(PROFILES[key]), KB, NOW);
const findOne = (key, id) => obligationsOf(key).find((o) => o.id === id);

// ── The headline: a clock with days left ───────────────────────────────────

const critical = findOne('custody-critical', 'custody-clock');
check('custody-critical produces a custody clock', !!critical);
check('  it is critical, not merely noted', critical && critical.severity === 'critical', critical && critical.severity);
check('  13 days remain, which is the demonstration',
  critical && critical.clock.remainingDays === 13, critical && String(critical.clock.remainingDays));
check('  the window came from the charged sections, not a default',
  critical && critical.certain === true && critical.clock.windowDays === 60);
check('  the accused is named in the finding', critical && /Ramesh Kumar/.test(critical.finding));
check('  it also raises the missing statements, at high because someone is in custody',
  findOne('custody-critical', 'no-statements')?.severity === 'high');

// ── The clock that has already run out ─────────────────────────────────────

const over = findOne('custody-overdue', 'custody-clock');
check('custody-overdue produces an overdue clock', over && over.severity === 'overdue', over && over.severity);
check('  it reports days past the deadline, not days left',
  over && over.clock.remainingDays === -4, over && String(over.clock.remainingDays));
check('  and says the accused is entitled to release now',
  over && /entitled to release/i.test(over.title));

// ── Evidence that is about to stop existing ────────────────────────────────

const cctv = obligationsOf('cctv-lapsing').find((o) => o.id.startsWith('electronic-evidence'));
check('cctv-lapsing produces an electronic-evidence obligation', !!cctv);
check('  the clock is the recorder, not the law', cctv && cctv.clock.kind === 'physical');
check('  four days before it laps', cctv && cctv.clock.remainingDays === 4, cctv && String(cctv.clock.remainingDays));
check('  it explains the footage would be inadmissible', cctv && /not admissible/.test(cctv.consequence));
check('  no custody clock — nobody is in custody on it',
  !findOne('cctv-lapsing', 'custody-clock'));

// ── A case that has gone silent ────────────────────────────────────────────

const quiet = findOne('quiet-case', 'diary-silent');
check('quiet-case produces a silence obligation', !!quiet);
check('  96 days of silence is reported', quiet && /96 days/.test(quiet.finding), quiet && quiet.finding);
check('  at high, because a case silent this long reads badly at trial',
  quiet && quiet.severity === 'high', quiet && quiet.severity);

// ── The control ────────────────────────────────────────────────────────────
//
// This one matters as much as the rest. A queue where every case is on fire
// teaches an officer nothing and trains them to ignore it, so the seed has to
// include a file that is simply in order.

const clean = obligationsOf('clean-case');
check('clean-case raises nothing at all', clean.length === 0, JSON.stringify(clean.map((o) => o.id)));

// ── The queue as a whole ───────────────────────────────────────────────────

const queue = statutory.buildQueue(
  Object.keys(PROFILES).map((k, i) => buildFromProfile(PROFILES[k], i)), KB, NOW,
);
check('the seeded set produces a populated queue', queue.counts.total >= 5, String(queue.counts.total));
check('exactly one item is overdue', queue.counts.overdue === 1, String(queue.counts.overdue));
check('at least one is critical', queue.counts.critical >= 1, String(queue.counts.critical));
check('the overdue item sorts first', queue.obligations[0].severity === 'overdue');
check('it spans several cases, not one noisy file',
  queue.counts.cases >= 4, String(queue.counts.cases));
check('every seeded case is marked as seeded in its record',
  Object.keys(PROFILES).every((k) => buildFromProfile(PROFILES[k]).seeded === true));

// ── The seeder's own guards, read from the source ──────────────────────────
//
// The parts that need a live bucket cannot run here, so the guarantees are
// asserted against the code that provides them. Thin, but it catches the case
// where someone later removes the guard that stops a seed overwriting real work.
const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
const seeder = src.slice(src.indexOf('async function handleInvestigationSeed'), src.indexOf('// ── Assurance console'));
check('seeding is admin-only', /role !== 'admin'/.test(seeder));
check('it refuses to touch a diary that already exists', /!record \|\| !created/.test(seeder));
check('it builds on real CaseMaster rows', /FROM CaseMaster/.test(seeder));
check('everything it writes is stamped seeded', /seeded: true/.test(seeder));
check('it writes an audit entry', /seed-investigations/.test(seeder));
check('it reports what it skipped, not only what it made', /skipped: skipped\.length/.test(seeder));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
