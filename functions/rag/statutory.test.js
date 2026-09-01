// Statutory obligations engine. Run: node functions/rag/statutory.test.js
//
// This engine puts a countdown in front of an officer and tells them what the
// law does when it reaches zero. Two failure modes are therefore tested with
// equal weight:
//
//   • A MISSED deadline. The custody clock is the one that releases a person;
//     if it fails to fire, or fires late, an accused walks.
//   • A WRONG deadline. Warning at 60 days on a case that allows 90 wastes
//     effort; the reverse loses the case. Where the two errors are that
//     unequal the engine must fail toward urgency, and say that it did.
//
// Every test pins `now` so the results cannot drift with the calendar.
const st = require('./statutory');
const KB = require('./legal_kb.json');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const DAY = 86_400_000;
const NOW = Date.parse('2026-03-01T09:00:00.000Z');
const daysAgo = (n) => NOW - n * DAY;

const baseCase = (over = {}) => ({
  caseMasterId: 'CM-1', crimeNo: '412/2026', status: 'Under Investigation',
  station: 'Vijayanagar', ioName: 'S Kumar',
  registeredDate: new Date(daysAgo(50)).toISOString(),
  lastDiaryDate: new Date(daysAgo(2)).toISOString(),
  sections: '379, 457',
  diaryEntries: [{ id: 'd1', ts: daysAgo(2) }],
  statements: [{ id: 's1', ts: daysAgo(3) }],
  evidence: [], persons: [], timeline: [], findings: [],
  ...over,
});

const arrestedCase = (daysInCustody, over = {}) => baseCase({
  persons: [{ id: 'p1', name: 'Ramesh K', role: 'Accused', status: 'Arrested', ts: daysAgo(daysInCustody) }],
  timeline: [{ id: 't1', type: 'Arrest', detail: 'Arrested at residence', ts: daysAgo(daysInCustody) }],
  ...over,
});

const find = (obs, id) => obs.find((o) => o.id === id);
const ids = (obs) => obs.map((o) => o.id);

// ── The custody clock ───────────────────────────────────────────────────────

const at47 = st.obligationsFor(arrestedCase(47), KB, NOW);
const custody = find(at47, 'custody-clock');
check('an accused in custody with no chargesheet raises the custody clock', !!custody);
check('the clock counts days already elapsed', custody.clock.elapsedDays === 47, String(custody.clock?.elapsedDays));
check('theft sections give the 60-day window', custody.clock.windowDays === 60, String(custody.clock?.windowDays));
check('and 13 days remain', custody.clock.remainingDays === 13, String(custody.clock?.remainingDays));
check('the title states the deadline, not the omission', /due in 13 days/.test(custody.title), custody.title);
check('the consequence names what the law does', /entitled to release on bail/.test(custody.consequence));
check('the finding names the accused', /Ramesh K/.test(custody.finding));
check('the basis for the window is stated', !!custody.basis && custody.certain === true, custody.basis);
check('the authority is cited with its legacy section',
  custody.authority.act === 'BNSS' && /CrPC 167/.test(custody.authority.legacy));
check('the citation is marked unverified, like the rest of the legal layer',
  custody.authority.verified === false);

// Severity has to move with the clock, or the queue cannot rank itself.
check('13 days out is critical', custody.severity === 'critical', custody.severity);
check('20 days out is high', find(st.obligationsFor(arrestedCase(40), KB, NOW), 'custody-clock').severity === 'high');
check('40 days out is medium', find(st.obligationsFor(arrestedCase(20), KB, NOW), 'custody-clock').severity === 'medium');

const overdue = find(st.obligationsFor(arrestedCase(64), KB, NOW), 'custody-clock');
check('past the window the obligation is overdue', overdue.severity === 'overdue', overdue.severity);
check('and says the accused is entitled to release NOW',
  /period has passed/.test(overdue.consequence) && /entitled to release/i.test(overdue.title));
check('negative days remaining are reported honestly', overdue.clock.remainingDays === -4,
  String(overdue.clock.remainingDays));

// ── The window depends on the offence, from the reference's own text ───────

const murder = st.custodyWindow('302', KB);
check('a section punishable with death gets the 90-day window', murder.days === 90, JSON.stringify(murder));
check('and names the section that decided it', /302/.test(murder.basis) && murder.certain);

const theft = st.custodyWindow('379', KB);
check('an ordinary offence gets the 60-day window', theft.days === 60);
check('and says no grave section was charged', /death, life, or ten years/.test(theft.basis));

const unknown = st.custodyWindow('9999', KB);
check('an unrecognised section falls back to the SHORTER window', unknown.days === 60);
check('and marks the basis uncertain rather than asserting it',
  unknown.certain === false && /not in the legal reference/.test(unknown.basis));
const none = st.custodyWindow('', KB);
check('no sections at all also falls back short and says so',
  none.days === 60 && none.certain === false && /no sections are recorded/.test(none.basis));

// The punishment classifier reads the reference's prose, so it must handle the
// forms that prose actually takes.
check('classifier: death', st.gravePunishment('Death, or imprisonment for life, and fine'));
check('classifier: life', st.gravePunishment('Imprisonment for life and fine'));
check('classifier: "ten years" in words', st.gravePunishment('Imprisonment of either description for ten years'));
check('classifier: numeric 10 years', st.gravePunishment('Imprisonment up to 10 years, or fine'));
check('classifier: 14 years is grave', st.gravePunishment('Rigorous imprisonment for fourteen years'));
check('classifier: 3 years is not', !st.gravePunishment('Imprisonment of either description for three years, or fine'));
check('classifier: 7 years is not', !st.gravePunishment('Imprisonment for 7 years and fine'));
check('classifier: fine only is not', !st.gravePunishment('Fine which may extend to one thousand rupees'));
check('classifier: empty is not', !st.gravePunishment(''));

check('section tokens survive a messy field',
  JSON.stringify(st.sectionTokens('379, 457 IPC and 34')) === JSON.stringify(['379', '457', '34']),
  JSON.stringify(st.sectionTokens('379, 457 IPC and 34')));

// ── The clock must NOT fire when it should not ─────────────────────────────

check('no custody clock once the chargesheet is filed',
  !find(st.obligationsFor(arrestedCase(47, { status: 'Chargesheet Filed' }), KB, NOW), 'custody-clock'));
check('no custody clock on a closed case',
  !find(st.obligationsFor(arrestedCase(47, { status: 'Closed' }), KB, NOW), 'custody-clock'));
check('no custody clock when nobody is in custody',
  !find(st.obligationsFor(baseCase(), KB, NOW), 'custody-clock'));
check('an accused on bail does not start the custody clock',
  !find(st.obligationsFor(baseCase({
    persons: [{ id: 'p1', name: 'R', role: 'Accused', status: 'On bail', ts: daysAgo(47) }],
  }), KB, NOW), 'custody-clock'));
check('a witness marked arrested does not start the custody clock',
  !find(st.obligationsFor(baseCase({
    persons: [{ id: 'p1', name: 'W', role: 'Witness', status: 'Arrested', ts: daysAgo(47) }],
  }), KB, NOW), 'custody-clock'));

// An explicit Arrest event is more reliable than when the person row was typed.
const bothDates = st.obligationsFor(baseCase({
  persons: [{ id: 'p1', name: 'R', role: 'Accused', status: 'Arrested', ts: daysAgo(10) }],
  timeline: [{ id: 't1', type: 'Arrest', ts: daysAgo(47) }],
}), KB, NOW);
check('the timeline arrest date is preferred over the data-entry date',
  find(bothDates, 'custody-clock').clock.elapsedDays === 47);

const noArrestEvent = st.obligationsFor(baseCase({
  persons: [{ id: 'p1', name: 'R', role: 'Accused', status: 'Arrested', ts: daysAgo(30) }],
}), KB, NOW);
check('with no arrest event it falls back to the person entry date',
  find(noArrestEvent, 'custody-clock').clock.elapsedDays === 30);

// ── Electronic evidence ────────────────────────────────────────────────────

const cctv = st.obligationsFor(baseCase({
  evidence: [{ id: 'e1', type: 'Digital', description: 'Shop CCTV, 22:00-23:00', ts: daysAgo(26) }],
}), KB, NOW);
const elec = cctv.find((o) => o.id.startsWith('electronic-evidence'));
check('digital evidence with no certificate is raised', !!elec);
check('it explains that the footage is inadmissible without it',
  /not admissible/.test(elec.consequence));
check('it carries the overwrite clock, not a legal one', elec.clock.kind === 'physical');
check('four days before the recorder laps it is critical',
  elec.clock.remainingDays === 4 && elec.severity === 'critical', String(elec.clock.remainingDays));
check('the retention figure is presented as an estimate, not law',
  /typically/.test(elec.basis) && elec.certain === false);
check('BSA 63 is cited with its IEA predecessor',
  elec.authority.act === 'BSA' && /65B/.test(elec.authority.legacy));

check('a certificate already referenced clears the obligation',
  !st.obligationsFor(baseCase({
    evidence: [{ id: 'e1', type: 'Digital', description: 'CCTV', certificateRef: '65B cert dated 04/02', ts: daysAgo(26) }],
  }), KB, NOW).some((o) => o.id.startsWith('electronic-evidence')));
check('physical evidence does not raise an electronic-certificate obligation',
  !st.obligationsFor(baseCase({
    evidence: [{ id: 'e1', type: 'Physical', description: 'Crowbar', seizureMemoRef: 'SM/12', ts: daysAgo(5) }],
  }), KB, NOW).some((o) => o.id.startsWith('electronic-evidence')));

// ── The rest of the obligations ────────────────────────────────────────────

const noMemo = st.obligationsFor(baseCase({
  evidence: [{ id: 'e1', type: 'Physical', description: 'Gold chain', ts: daysAgo(3) }],
}), KB, NOW);
check('a physical exhibit with no seizure reference is raised', !!find(noMemo, 'seizure-memo'));
check('it says the exhibit can be excluded, not that the officer erred',
  /excluded/.test(find(noMemo, 'seizure-memo').consequence)
  && !/you failed/i.test(find(noMemo, 'seizure-memo').finding));

check('a forensic exhibit with no lab report is raised',
  !!find(st.obligationsFor(baseCase({
    evidence: [{ id: 'e1', type: 'Forensic', description: 'Swab', seizureMemoRef: 'SM/1', fslStatus: 'Sent — pending', ts: daysAgo(40) }],
  }), KB, NOW), 'fsl-pending'));

const noStmt = st.obligationsFor(baseCase({ statements: [] }), KB, NOW);
check('no statements is raised', !!find(noStmt, 'no-statements'));
check('it is only medium without an accused in custody', find(noStmt, 'no-statements').severity === 'medium');
check('but high when someone is in custody on it',
  find(st.obligationsFor(arrestedCase(20, { statements: [] }), KB, NOW), 'no-statements').severity === 'high');

const noDiary = st.obligationsFor(baseCase({ diaryEntries: [], lastDiaryDate: '' }), KB, NOW);
check('an empty case diary is raised', !!find(noDiary, 'no-diary'));
check('and states how long it has been empty', /50 days ago/.test(find(noDiary, 'no-diary').finding));

check('a quiet case is raised at 30 days',
  !!find(st.obligationsFor(baseCase({ lastDiaryDate: new Date(daysAgo(45)).toISOString() }), KB, NOW), 'diary-silent'));
check('but not at 20 days',
  !find(st.obligationsFor(baseCase({ lastDiaryDate: new Date(daysAgo(20)).toISOString() }), KB, NOW), 'diary-silent'));

check('an untraced accused is raised',
  !!find(st.obligationsFor(baseCase({
    persons: [{ id: 'p1', name: 'R', role: 'Accused', status: 'Absconding', ts: daysAgo(5) }],
  }), KB, NOW), 'accused-at-large'));

// A well-kept case must produce a quiet queue, or officers stop reading it.
const tidy = st.obligationsFor(baseCase({
  evidence: [{ id: 'e1', type: 'Physical', description: 'Crowbar', seizureMemoRef: 'SM/12', ts: daysAgo(4) }],
}), KB, NOW);
check('a well-kept case raises nothing at all', tidy.length === 0, JSON.stringify(ids(tidy)));

// ── Ranking ────────────────────────────────────────────────────────────────

const queue = st.buildQueue([
  arrestedCase(47, { caseMasterId: 'CM-A', crimeNo: '412/2026' }),
  baseCase({
    caseMasterId: 'CM-B', crimeNo: '388/2026', statements: [],
    evidence: [{ id: 'e1', type: 'Digital', description: 'CCTV', ts: daysAgo(26) }],
  }),
  baseCase({ caseMasterId: 'CM-C', crimeNo: '401/2026', statements: [] }),
], KB, NOW);

check('the queue spans every case', queue.counts.cases === 3, String(queue.counts.cases));
check('the most urgent clock is first',
  queue.obligations[0].clock?.remainingDays <= queue.obligations[1].clock?.remainingDays
  || queue.obligations[0].severity === 'overdue',
  queue.obligations.slice(0, 2).map((o) => `${o.id}:${o.severity}`).join(' , '));
check('critical items outrank medium ones',
  queue.obligations.findIndex((o) => o.severity === 'critical')
  < queue.obligations.findIndex((o) => o.severity === 'medium'));
check('counts are broken out by severity',
  queue.counts.critical >= 1 && queue.counts.total === queue.obligations.filter((o) => !o.acknowledged).length);

const overdueQueue = st.buildQueue([arrestedCase(70), baseCase({ caseMasterId: 'CM-Z', statements: [] })], KB, NOW);
check('an overdue obligation sorts above everything', overdueQueue.obligations[0].severity === 'overdue');
check('overdue is counted separately', overdueQueue.counts.overdue === 1);

// ── Acknowledgement: done-offline must be possible, and visible ────────────

const acked = st.buildQueue([arrestedCase(47, {
  obligationAcks: { 'custody-clock': { by: 'kumar@ksp.gov.in', at: NOW, note: 'Chargesheet filed at court today' } },
})], KB, NOW);
const ackedItem = acked.obligations.find((o) => o.id === 'custody-clock');
check('an acknowledged obligation is kept, not deleted', !!ackedItem);
check('it records who dismissed it and why',
  ackedItem.acknowledged.by === 'kumar@ksp.gov.in' && /Chargesheet filed/.test(ackedItem.acknowledged.note));
check('it drops out of the open count', acked.counts.total === 0 && acked.counts.acknowledged === 1);
check('and ranks last', acked.obligations[acked.obligations.length - 1].id === 'custody-clock');

// ── Robustness: the queue must never blank ────────────────────────────────

check('a malformed record does not take the queue down',
  st.buildQueue([null, undefined, {}, { persons: 'not-an-array' }, arrestedCase(47)], KB, NOW)
    .obligations.some((o) => o.id === 'custody-clock'));
check('no records gives an empty queue, not an error',
  st.buildQueue([], KB, NOW).counts.total === 0);
check('a missing legal reference still produces the clock (short window)',
  find(st.obligationsFor(arrestedCase(47), [], NOW), 'custody-clock').clock.windowDays === 60);
check('an unparseable registration date does not throw',
  Array.isArray(st.obligationsFor(baseCase({ registeredDate: 'not a date', diaryEntries: [] }), KB, NOW)));

// ── Wording discipline ────────────────────────────────────────────────────
//
// Every finding is a claim about the FILE, never about the officer. Get this
// wrong and the panel reads as an accusation for work that was actually done.
const everything = st.obligationsFor(baseCase({
  statements: [], diaryEntries: [], lastDiaryDate: '',
  persons: [{ id: 'p1', name: 'R', role: 'Accused', status: 'Arrested', ts: daysAgo(47) }],
  timeline: [{ id: 't1', type: 'Arrest', ts: daysAgo(47) }],
  evidence: [
    { id: 'e1', type: 'Digital', description: 'CCTV', ts: daysAgo(26) },
    { id: 'e2', type: 'Physical', description: 'Crowbar', ts: daysAgo(26) },
  ],
}), KB, NOW);
check('a neglected case raises the full set', everything.length >= 6, String(everything.length));
for (const o of everything) {
  check(`"${o.id}" blames the record, not the officer`,
    !/\byou (failed|did not|neglected)\b/i.test(`${o.finding} ${o.consequence}`), o.finding);
  check(`"${o.id}" states a consequence, not just a gap`, (o.consequence || '').length > 30);
  check(`"${o.id}" says what to do next`, (o.action || '').length > 20);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
