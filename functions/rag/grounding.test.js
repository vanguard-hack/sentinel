// Answer-vs-retrieval grounding. Run: node functions/rag/grounding.test.js
//
// Two ways to fail here, and the second is the one that kills the feature:
//
//   MISS   — an invented crime number passes as a finding.
//   WOLF   — a correct answer is flagged, teaching officers to ignore the
//            strip. A warning nobody reads protects nothing, so roughly half
//            of these tests assert that something is NOT flagged.
const grounding = require('./grounding');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// Real shapes from ksp/fir/CaseMaster.csv.
const ROWS = [
  { CaseMasterID: 1, CrimeNo: '144221107202500001', CaseNo: '202500001', BriefFacts: 'Vehicle theft at College Circle.' },
  { CaseMasterID: 2, CrimeNo: '144031013202300001', CaseNo: '202300001', BriefFacts: 'Identity theft after an online contact.' },
];
const withRows = (rows = ROWS) => {
  const c = grounding.collector();
  c.add(rows, rows.length);
  return c;
};
const flagged = (r) => r.unsupported.map((u) => u.value);

// ── Extraction ─────────────────────────────────────────────────────────────
check('an 18-digit crime number is recognised',
  grounding.extract('see 144221107202500001').some((t) => t.kind === 'crime_number'));
check('a 9-digit case number is recognised',
  grounding.extract('case 202500001 refers').some((t) => t.kind === 'case_number'));
check('a minted reference is recognised',
  grounding.extract('RPT-2026-00042 attached').some((t) => t.kind === 'reference'));
check('a plain count is NOT treated as an identifier',
  grounding.extract('there were 42 cases and 7 arrests').length === 0);
check('a phone number is not an identifier either',
  grounding.extract('contact on 9845012345').length === 0);

// The slash form: "123/2025" is far more often a date than an FIR number, and
// this deployment stores no identifier in that shape at all.
check('a bare date-like fraction is not flagged as an FIR number',
  grounding.extract('registrations rose through 12/2025 and 01/2026').length === 0);
check('but the same shape behind an explicit cue IS an identifier',
  grounding.extract('FIR 123/2025 was registered').some((t) => t.kind === 'fir_number'));

// ── The failure this exists for ────────────────────────────────────────────
const invented = grounding.check(
  'There were four theft cases in Mysuru: 144221107202500001, 144031013202300001, '
  + 'and 144999999202600999.',
  { evidence: withRows(), question: 'theft cases in Mysuru' }
);
check('a crime number that was never retrieved is caught',
  flagged(invented).includes('144999999202600999'));
check('and the retrieved ones are left alone',
  flagged(invented).length === 1, flagged(invented).join(','));
check('the verdict is not "grounded"', invented.grounded === false);
check('the officer is told which number to distrust',
  /144999999202600999/.test(grounding.warning(invented)) && /unverified/i.test(grounding.warning(invented)));

check('an answer using only retrieved numbers is clean',
  grounding.check('Two cases matched: 144221107202500001 and 144031013202300001.',
    { evidence: withRows(), question: 'theft cases' }).grounded === true);

// A lane with no retrieval at all — casual chat — must not become a licence to
// invent. Nothing was read, so any record number is the model's own.
check('an identifier invented with no retrieval behind it is caught',
  flagged(grounding.check('Case 202600123 is still open.', { question: 'how are you?' }))
    .includes('202600123'));

// ── Not crying wolf ────────────────────────────────────────────────────────
// The measured one. Asked about a number that does not exist, the assistant
// correctly says so — and a naive checker flags the number it was handed.
const denial = grounding.check(
  'No record was found for crime number 144221107202500999.',
  { evidence: withRows([]), question: 'what is the status of 144221107202500999?' }
);
check('repeating the identifier the OFFICER typed is not an invention',
  denial.grounded === true, flagged(denial).join(','));

check('a case named earlier in the conversation is still supported',
  grounding.check('That case, 144031013202300001, is under investigation.', {
    evidence: withRows([]),
    question: 'what about that one?',
    history: [{ role: 'user', content: 'tell me about 144031013202300001' }],
  }).grounded === true);

check('a summary with no identifiers at all is not flagged',
  grounding.check('Theft accounts for most registrations in this district.',
    { evidence: withRows() }).grounded === true);
check('and reports nothing to say rather than an empty finding',
  grounding.check('Theft is the most common offence.', { evidence: withRows() }).checked === false);

check('an identifier deep in a retrieved row is supported, not just the first few',
  grounding.check('See 144000000202600299.', {
    evidence: withRows([...Array(300)].map((_, i) => ({ CrimeNo: `1440000002026${String(i).padStart(5, '0')}` }))),
  }).grounded === true);

check('formatting differences do not create a phantom invention',
  grounding.check('Crime No. 202500001 refers.',
    { evidence: withRows(), question: 'x' }).grounded === true);

// ── Legal citations, against the reference rather than against retrieval ───
check('a section inside the legal reference is accepted',
  grounding.check('This is charged under IPC 302.', { evidence: withRows() }).grounded === true);
check('a section OUTSIDE it is flagged — that is the model answering from memory',
  flagged(grounding.check('This attracts IPC 124A.', { evidence: withRows() })).includes('IPC 124A'));
check('the warning for a section says to check the bare Act',
  /bare Act/i.test(grounding.warning(grounding.check('This attracts IPC 124A.', { evidence: withRows() }))));
check('a BNS number that the reference maps to is accepted',
  grounding.check('The BNS equivalent is BNS 303(2).', { evidence: withRows() }).grounded === true);
check('a section quoted straight out of a retrieved record is supported',
  grounding.check('The FIR cites IPC 411.', {
    evidence: withRows([{ CaseMasterID: 9, Act: 'IPC', SectionCode: '411' }]),
  }).grounded === true);

// ── The opposite failure: denying what was read ────────────────────────────
const contradiction = grounding.check('No matching records were found.', { evidence: withRows() });
check('an answer denying records when rows WERE retrieved is caught',
  contradiction.contradiction === true);
check('and the officer is pointed at the sources',
  /2 records were retrieved/.test(grounding.warning(contradiction)));
check('the same sentence with nothing retrieved is correct, not a contradiction',
  grounding.check('No matching records were found.', { evidence: withRows([]) }).contradiction === false);

// ── Robustness ─────────────────────────────────────────────────────────────
check('an empty answer is not flagged', grounding.check('', { evidence: withRows() }).checked === false);
check('a missing evidence collector does not throw',
  grounding.check('Case 202600123 is open.').unsupported.length === 1);
check('the same invented number twice is reported once',
  flagged(grounding.check('202600123 and again 202600123.', {})).length === 1);
check('a flood of inventions is capped rather than filling the screen',
  grounding.check([...Array(40)].map((_, i) => `20260${String(i).padStart(4, '0')}`).join(' '), {})
    .unsupported.length === 10);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
