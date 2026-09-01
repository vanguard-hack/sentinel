'use strict';

/**
 * Control self-test — proving the safeguards are running HERE, not in CI.
 *
 * THE FAILURE THIS EXISTS FOR
 *
 * A control that passes its unit tests and is dead in production is worse than
 * no control, because everyone believes it is working. That is not a
 * hypothetical: a comparable system shipped a "tamper-evident hash-chained
 * audit log" whose hash columns did not exist on the deployed table, so the
 * chain silently never wrote — for weeks, while the feature was reported as
 * complete. CI could not have caught it. Only running the control against the
 * live deployment can.
 *
 * So this module takes the safeguards Sentinel actually depends on — audit
 * tamper-evidence, answer grounding, clearance redaction, export screening —
 * and exercises them, in production, against inputs whose correct outcome is
 * known. It then reports what it attempted, what it expected, and what the
 * system actually did.
 *
 * WHAT MAKES THIS HONEST
 *
 *   • It calls the REAL modules. Not a copy, not a description, not a
 *     recorded result — `require('./integrity')` and the rest, the same code
 *     paths that run for a live officer. If a control were removed tomorrow,
 *     these checks would fail rather than keep reporting green.
 *
 *   • It attacks rather than exercises. Every check tries to get something
 *     past the control: an edited audit entry, a fabricated FIR number, a
 *     victim's name requested by a role that may not see it, a protected
 *     report walked out as a PDF. A control nobody has attacked is a
 *     decoration.
 *
 *   • It treats a FALSE ALARM as a failure too. A grounding check that flags
 *     the officer's own words, or an integrity check that cries tampering
 *     over data written before hashing existed, is a control that will be
 *     switched off within a week. Both directions are tested.
 *
 * WHAT IT IS NOT
 *
 * It is not a substitute for the test suites — those are broader and run on
 * every push. This answers the narrower question CI cannot: are the controls
 * alive in THIS deployment, right now.
 */

const integrity = require('./integrity');
const grounding = require('./grounding');
const redaction = require('./redaction');
const exportscreen = require('./exportscreen');

const clone = (v) => JSON.parse(JSON.stringify(v));

/** One assertion, recorded with enough context to be read as evidence. */
const probe = (name, attack, expected, observed, pass) => ({
  name, attack, expected, observed, pass: !!pass,
});

// ── Control 1: audit tamper-evidence ────────────────────────────────────────
//
// The scenario, stated plainly: an officer looks up a record they should not
// have, and later edits or deletes that line from the log. Every check below
// is a way of doing exactly that.

function auditControl() {
  const checks = [];

  const EVENTS = [
    { ts: 1756000000000, email: 'kumar@ksp.gov.in', role: 'investigator', feature: 'Case Files',
      action: 'view', path: '/case-files', detail: 'Case 412/2026', ip: '10.1.2.3', location: 'Bengaluru' },
    { ts: 1756000060000, email: 'rao@ksp.gov.in', role: 'supervisor', feature: 'Access & Audit',
      action: 'export-csv', path: '/access', detail: '120 events', ip: '10.1.2.9', location: 'Mysuru' },
  ];

  const sealed = { events: clone(EVENTS), integrity: integrity.sealBlob(EVENTS) };
  const fileA = { key: 'selftest/2026-08-30/1-aaa.json', blob: sealed };
  const fileB = {
    key: 'selftest/2026-08-30/2-bbb.json',
    blob: (() => { const e = [clone(EVENTS[1])]; return { events: e, integrity: integrity.sealBlob(e) }; })(),
  };
  const asEntries = (files) => files.map((f) => ({
    key: f.key, hash: f.blob.integrity.events, count: f.blob.events.length,
  }));
  const sealArgs = {
    day: '2026-08-30', prevSealHash: integrity.GENESIS, prevDay: null, seq: 1,
    sealedAt: '2026-08-31T00:05:00.000Z',
  };
  const seal = integrity.buildSeal({ ...sealArgs, blobs: asEntries([fileA, fileB]) });
  const day = (blobs, s) => [{ day: '2026-08-30', blobs, seal: s }];
  const kinds = (v) => v.problems.map((p) => p.kind);

  // Baseline: an untouched day must come back clean. If this fails, every
  // "caught" result below is meaningless — the verifier is simply alarming.
  const cleanVerdict = integrity.verify(day([fileA, fileB], seal));
  checks.push(probe(
    'An untouched day verifies as intact',
    'Nothing altered — the control must stay silent',
    'intact, no problems reported',
    cleanVerdict.intact ? 'intact' : `problems: ${kinds(cleanVerdict).join(', ')}`,
    cleanVerdict.intact,
  ));

  // The quiet correction: one entry edited in place.
  const edited = clone(sealed);
  edited.events[0].detail = 'Case 999/2026';
  const editedStatus = integrity.verifyBlob('k1', edited).status;
  checks.push(probe(
    'An entry edited after the fact is caught',
    'Changed one logged entry\'s detail from "Case 412/2026" to "Case 999/2026"',
    'status: altered',
    `status: ${editedStatus}`,
    editedStatus === 'altered',
  ));

  // The deleted line: one entry removed from a file.
  const shortened = clone(sealed);
  shortened.events.splice(0, 1);
  const shortenedStatus = integrity.verifyBlob('k1', shortened).status;
  checks.push(probe(
    'An entry removed from a file is caught',
    'Deleted the first logged entry from the file',
    'status: altered',
    `status: ${shortenedStatus}`,
    shortenedStatus === 'altered',
  ));

  // The wholesale deletion: an entire file of entries disappears. Without a
  // day seal this is invisible — the day just looks like it had less traffic.
  const deleted = integrity.verify(day([fileB], seal));
  checks.push(probe(
    'A whole file of entries deleted is caught by the day seal',
    'Removed an entire audit file the day seal had recorded',
    'problem: DELETED_FILE',
    kinds(deleted).join(', ') || 'no problem reported',
    kinds(deleted).includes('DELETED_FILE'),
  ));

  // The insertion: entries added to a day that was already closed.
  const fileC = {
    key: 'selftest/2026-08-30/3-ccc.json',
    blob: (() => { const e = [{ ts: 1, detail: 'inserted' }]; return { events: e, integrity: integrity.sealBlob(e) }; })(),
  };
  const backdated = integrity.verify(day([fileA, fileB, fileC], seal));
  checks.push(probe(
    'Entries inserted into a closed day are caught',
    'Added a new audit file to a day that had already been sealed',
    'problem: BACKDATED_FILE',
    kinds(backdated).join(', ') || 'no problem reported',
    kinds(backdated).includes('BACKDATED_FILE'),
  ));

  // The cover-up: rewrite the seal itself so the tampering above verifies.
  const forgedSeal = { ...clone(seal), blobs: asEntries([fileB]) };
  const forged = integrity.verify(day([fileB], forgedSeal));
  checks.push(probe(
    'Rewriting the seal to cover a deletion is caught',
    'Deleted a file, then edited the day seal to say it was never there',
    'problem: ALTERED_SEAL',
    kinds(forged).join(', ') || 'no problem reported',
    kinds(forged).includes('ALTERED_SEAL'),
  ));

  // The opposite failure, and it matters as much: entries written before
  // hashing existed must read as UNVERIFIABLE, never as altered. Calling old
  // data tampering is how a verifier loses its credibility in one morning.
  const legacyStatus = integrity.verifyBlob('k0', { events: clone(EVENTS) }).status;
  checks.push(probe(
    'Entries written before hashing existed are not called tampering',
    'Presented a file with no fingerprint, as legacy rows would be',
    'status: unverifiable (NOT altered)',
    `status: ${legacyStatus}`,
    legacyStatus === 'unverifiable',
  ));

  return {
    id: 'audit-integrity',
    name: 'Audit tamper-evidence',
    what: 'Every access is logged, hashed, and sealed into a per-day chain. These checks alter the log the way someone covering their tracks would, and require each attempt to be caught and correctly named.',
    module: 'functions/rag/integrity.js',
    checks,
  };
}

// ── Control 2: answer grounding ─────────────────────────────────────────────
//
// Citations are built from retrieval, so they are always real. The risk runs
// the other way: an identifier appearing in the PROSE that was never retrieved.
// The officer then goes looking for a file that does not exist.

function groundingControl() {
  const checks = [];

  const retrieved = grounding.collector();
  retrieved.add([
    { CrimeNo: '144221107202500123', District: 'Mysuru', CrimeGroup: 'Theft' },
    { CrimeNo: '144221107202500456', District: 'Mysuru', CrimeGroup: 'Theft' },
  ], 2);

  // A fabricated crime number wrapped in otherwise-correct prose. This is the
  // realistic failure: three real records read, a fourth invented, and nothing
  // on the screen looks wrong.
  const invented = grounding.check(
    'There were three theft cases in Mysuru: 144221107202500123, 144221107202500456 and 144221107202500999.',
    { evidence: retrieved, question: 'theft cases in Mysuru' },
  );
  const flagged = invented.unsupported.map((u) => u.value);
  checks.push(probe(
    'An identifier that was never retrieved is flagged',
    'Answer cites two genuine crime numbers plus one that was never read',
    'flags 144221107202500999 as unsupported',
    flagged.length ? `flagged: ${flagged.join(', ')}` : 'nothing flagged',
    !invented.grounded && flagged.includes('144221107202500999'),
  ));

  // The clean case must stay clean, or the warning strip becomes wallpaper.
  const honest = grounding.check(
    'Two theft cases were registered in Mysuru: 144221107202500123 and 144221107202500456.',
    { evidence: retrieved, question: 'theft cases in Mysuru' },
  );
  checks.push(probe(
    'An answer that stays inside what was read passes clean',
    'Answer cites only the two records actually retrieved',
    'grounded, nothing flagged',
    honest.grounded ? 'grounded' : `flagged: ${honest.unsupported.map((u) => u.value).join(', ')}`,
    honest.grounded,
  ));

  // The false positive that would kill the feature: an officer asks about a
  // crime number that does not exist, the system correctly says so, and a
  // naive checker flags the number in its own denial.
  const empty = grounding.collector();
  const denial = grounding.check(
    'No record was found for 144221107202500999.',
    { evidence: empty, question: 'show me case 144221107202500999' },
  );
  checks.push(probe(
    'A correct "no record found" reply is not flagged',
    'Officer asked about a non-existent case; the answer correctly says so',
    'grounded — the number came from the officer, not the model',
    denial.grounded ? 'grounded' : `wrongly flagged: ${denial.unsupported.map((u) => u.value).join(', ')}`,
    denial.grounded,
  ));

  // The inverse failure: records WERE read and the answer denies they exist.
  const contradiction = grounding.check(
    'No records matching that description were found in the database.',
    { evidence: retrieved, question: 'theft cases in Mysuru' },
  );
  checks.push(probe(
    'An answer denying records that were read is caught',
    'Two records retrieved, but the answer claims nothing was found',
    'contradiction reported',
    contradiction.contradiction ? 'contradiction reported' : 'not caught',
    contradiction.contradiction,
  ));

  return {
    id: 'grounding',
    name: 'Answer grounding',
    what: 'Citations are built from what was retrieved, so they cannot be invented. This checks the other direction — that every identifier appearing in the answer text came from a record actually read, the officer\'s own question, or the conversation.',
    module: 'functions/rag/grounding.js',
    checks,
  };
}

// ── Control 3: clearance and redaction ──────────────────────────────────────
//
// Fields are stripped BEFORE rows reach the model, not after the answer is
// written. Once sensitive data is in the prompt the model has seen it, and it
// can resurface through paraphrase or a later turn.

function clearanceControl() {
  const checks = [];

  const row = {
    CrimeNo: '144221107202500123',
    District: 'Mysuru',
    CrimeGroup: 'Theft',
    VictimName: 'Lakshmi Devi',
    AccusedName: 'Ramesh K',
    latitude: 12.29581,
    longitude: 76.63929,
    BriefFacts: 'Complainant reports the theft of gold ornaments from her residence.',
  };

  const asAnalyst = redaction.filterRows([row], 'analyst');
  const analystRow = asAnalyst.rows[0];
  checks.push(probe(
    'A victim\'s name is withheld from a role without clearance',
    'Requested a case row as an analyst, whose clearance is below the identity tier',
    'VictimName redacted',
    analystRow.VictimName === 'Lakshmi Devi' ? 'LEAKED — name returned in full' : `VictimName = ${analystRow.VictimName}`,
    analystRow.VictimName !== 'Lakshmi Devi',
  ));

  // Coarsening rather than deletion: an analyst studying where thefts cluster
  // needs the neighbourhood and has no operational need for the doorstep.
  const coarsened = analystRow.latitude !== 12.29581 && analystRow.latitude !== '[redacted]';
  checks.push(probe(
    'Coordinates are coarsened, not destroyed, for lower clearance',
    'Requested a precise incident coordinate as an analyst',
    'rounded to ~11 km, so district clustering still works',
    `latitude = ${analystRow.latitude}`,
    coarsened,
  ));

  const asInvestigator = redaction.filterRows([row], 'investigator');
  checks.push(probe(
    'A cleared role still sees the full record',
    'Requested the same row as an investigator, who is cleared for it',
    'VictimName returned in full',
    `VictimName = ${asInvestigator.rows[0].VictimName}`,
    asInvestigator.rows[0].VictimName === 'Lakshmi Devi',
  ));

  // Protected identity: on these case types even a cleared officer must state
  // a reason before a name is released.
  // isProtected() keys on CrimeHead / CrimeMajorHead, not CrimeGroup — taking
  // the value from the exported set rather than retyping it means this check
  // keeps testing the real rule if the protected categories are ever widened.
  const protectedRow = { ...row, CrimeHead: [...redaction.PROTECTED_HEADS][0] };
  const noReason = redaction.filterRows([protectedRow], 'investigator');
  const withReason = redaction.filterRows([protectedRow], 'investigator', { reason: 'Court-ordered disclosure, PT 44/2026' });
  const guarded = redaction.isProtected(protectedRow);
  checks.push(probe(
    'On a protected case, a cleared officer must state a reason first',
    'Requested a protected-category victim name as a cleared investigator, with no reason given',
    'name withheld until a reason is recorded',
    guarded
      ? `without reason: ${noReason.rows[0].VictimName} · with reason: ${withReason.rows[0].VictimName}`
      : 'sample row not recognised as protected',
    guarded && noReason.rows[0].VictimName !== 'Lakshmi Devi' && withReason.rows[0].VictimName === 'Lakshmi Devi',
  ));

  checks.push(probe(
    'Every removal is reported, not silently applied',
    'Inspected what the redaction pass reported back to the audit trail',
    'a list naming each field and what was done to it',
    asAnalyst.redactions.length
      ? asAnalyst.redactions.map((r) => `${r.field}: ${r.action}`).join(', ')
      : 'nothing reported',
    asAnalyst.redactions.length > 0,
  ));

  return {
    id: 'clearance',
    name: 'Clearance & redaction',
    what: 'Fields carrying identity are stripped before rows are assembled into the model\'s context — not after the answer is written. Coordinates are coarsened rather than deleted so lower-clearance analysis still works, and protected identities need a stated reason even from cleared officers.',
    module: 'functions/rag/redaction.js',
    checks,
  };
}

// ── Control 4: export screening ─────────────────────────────────────────────
//
// Clearance governs what may be READ. This governs what may LEAVE — a document
// assembled from a dozen individually-authorised reads whose aggregate nobody
// ever approved.

function exportControl() {
  const checks = [];

  const benign = exportscreen.screen(
    '<h1>District Crime Summary</h1><p>Theft cases in Mysuru, Jan-Mar 2026. 47 FIRs registered, 12 chargesheeted.</p>',
  );
  checks.push(probe(
    'An ordinary report downloads without friction',
    'Screened a routine district crime summary',
    'cleared — no approval needed',
    benign.needsReview ? `held: ${exportscreen.summarise(benign)}` : 'cleared',
    !benign.needsReview,
  ));

  // The blank CCTNS forms print "Complainant / Informant", "Caste / Tribe" and
  // "Particulars of witnesses" as ordinary field labels. A screen that fires on
  // those flags every FIR ever exported, supervisors rubber-stamp, and the
  // control becomes theatre. This is the check that keeps it honest.
  const templateLabels = [
    '6. Complainant / Informant', '(ix) Caste / Tribe',
    '13. Particulars of witnesses to be examined', 'Signature of the informant',
  ].join(' \n ');
  const blank = exportscreen.screen(templateLabels, { isHtml: false });
  checks.push(probe(
    'Blank statutory forms are not flagged by their own field labels',
    'Screened the printed labels of a blank FIR, arrest report and charge sheet',
    'cleared — or supervisors would face dozens of approvals a day and stop reading',
    blank.needsReview ? `WRONGLY HELD: ${exportscreen.summarise(blank)}` : 'cleared',
    !blank.needsReview,
  ));

  const sensitive = exportscreen.screen(
    '<p>Statement of the minor victim recorded. A protected witness will depose at trial.</p>',
  );
  checks.push(probe(
    'A report naming a child victim and a protected witness is held',
    'Screened a report referring to a minor victim and a protected witness',
    'held, citing both categories',
    sensitive.needsReview ? `held: ${exportscreen.summarise(sensitive)}` : 'NOT HELD',
    sensitive.needsReview && sensitive.reasons.length >= 2,
  ));

  // The document nobody would flag by eye: no alarming word anywhere, just a
  // large amount of personal data leaving at once.
  const roster = Array.from({ length: 40 }, (_, i) => `Accused ${i + 1} — 9${String(800000000 + i).padStart(9, '0')}`).join('\n');
  const bulk = exportscreen.screen(roster, { isHtml: false });
  checks.push(probe(
    'A contact list disguised as a case report is held',
    'Screened a list of 40 accused with their phone numbers — no sensitive keyword anywhere in it',
    'held as bulk personal data',
    bulk.needsReview ? `held: ${exportscreen.summarise(bulk)}` : 'NOT HELD',
    bulk.reasons.some((r) => r.category === 'bulk-personal-data'),
  ));

  // Sentinel's own crime numbers are 18 digits. A naive 10-digit scan finds a
  // "phone number" inside every one of them.
  const crimeNos = ['144221107202500999', '144221107202500123', '144221107202500456',
    '144221107202500789', '144221107202500321', '144221107202500654'].join(', ');
  const notPhones = exportscreen.screen(crimeNos, { isHtml: false });
  checks.push(probe(
    'Long crime numbers are not mistaken for personal phone numbers',
    'Screened a report listing six 18-digit crime numbers',
    '0 phone numbers detected',
    `${notPhones.stats.phones} phone numbers detected`,
    notPhones.stats.phones === 0,
  ));

  return {
    id: 'export-control',
    name: 'Export control',
    what: 'Before a report leaves Sentinel it is screened for material that departmental policy says a second officer should sign off on. Clean reports download immediately; flagged ones are held for a supervisor, who cannot approve their own request.',
    module: 'functions/rag/exportscreen.js',
    checks,
  };
}

// Identity lives here rather than in the builders' return values, so a control
// that throws before it can describe itself still reports under the right name.
const REGISTRY = [
  { id: 'audit-integrity', name: 'Audit tamper-evidence', module: 'functions/rag/integrity.js',
    what: 'Every access is logged, hashed and sealed into a per-day chain.', run: auditControl },
  { id: 'grounding', name: 'Answer grounding', module: 'functions/rag/grounding.js',
    what: 'Identifiers in an answer must come from records actually retrieved.', run: groundingControl },
  { id: 'clearance', name: 'Clearance & redaction', module: 'functions/rag/redaction.js',
    what: 'Identity fields are stripped before rows reach the model.', run: clearanceControl },
  { id: 'export-control', name: 'Export control', module: 'functions/rag/exportscreen.js',
    what: 'Reports are screened for material needing a second signature before they leave.', run: exportControl },
];

/**
 * Run every control. Deliberately synchronous and dependency-free: this must
 * be able to report on the safeguards even when Stratus, ZCQL or the model
 * provider is having a bad day, because those are exactly the moments someone
 * asks whether the controls are still standing.
 */
function runSelfTest() {
  const controls = [];
  for (const entry of REGISTRY) {
    try {
      const c = entry.run();
      c.passed = c.checks.filter((k) => k.pass).length;
      c.failed = c.checks.length - c.passed;
      c.pass = c.failed === 0;
      controls.push(c);
    } catch (e) {
      // A control that throws is a FAILED control, never a missing one, and it
      // must keep its identity: the registry supplies the id and name rather
      // than the thrown result, so a control that blew up still appears in its
      // own slot — named, red, with the error — instead of as an anonymous row
      // the console cannot match to anything. Silence, or a mystery entry,
      // would read as "nothing to report" at the exact moment that is untrue.
      controls.push({
        id: entry.id, name: entry.name, what: entry.what, module: entry.module,
        checks: [], passed: 0, failed: 1, pass: false,
        error: (e && e.message) || String(e),
      });
    }
  }
  const total = controls.reduce((n, c) => n + c.checks.length, 0);
  const passed = controls.reduce((n, c) => n + c.passed, 0);
  return {
    ranAt: Date.now(),
    controls,
    summary: { controls: controls.length, checks: total, passed, failed: total - passed,
      pass: controls.every((c) => c.pass) },
  };
}

module.exports = { runSelfTest };
