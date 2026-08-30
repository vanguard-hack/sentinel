// A non-answer carries no sources. Run: node functions/rag/noanswer.test.js
//
// The rule the assistant has to hold: if it did not answer, there is nothing to
// attribute. A source chip beside "the records don't hold this" reads as though
// something WAS found, and invites the officer to open a record that does not
// exist.

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

// isNegative and its two regexes live in index.js's module scope; lifted from
// source the same way router.test.js does it, to keep this dependency-free.
const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
const grab = (decl) => {
  const i = src.indexOf(decl);
  if (i < 0) throw new Error('missing ' + decl);
  const end = src.indexOf('\n};', i);
  return src.slice(i, end + 3);
};
const negRe = src.match(/^const NEGATIVE_RE =\n[\s\S]*?;$/m)[0];
const metaRe = src.match(/^const META_RE =\n[\s\S]*?;$/m)[0];
// eslint-disable-next-line no-new-func
const isNegative = new Function(`${negRe}\n${metaRe}\n${grab('const isNegative = (t) =>')}\nreturn isNegative;`)();

// What the UI actually does with the verdict, mirrored from respondWith.
const shown = (text, sources) => (isNegative(text) ? [] : sources);
const SRC = [{ source_type: 'database_record', display_name: 'Data Store' }];

// ── Non-answers: nothing to show ──────────────────────────────────────────
const nonAnswers = [
  'I don\'t know the answer to that.',
  'I\'m not sure — that information is not available in the records.',
  'The provided context does not contain the number of FIRs for Belagavi.',
  'I couldn\'t find any matching case.',
  'Unable to answer that from the case records.',
  'The available context does not mention that officer.',
  '',
  '   ',
];
nonAnswers.forEach((t) =>
  check(`no sources for: "${t.trim().slice(0, 48) || '(empty)'}"`, shown(t, SRC).length === 0));

// ── Real answers keep their attribution ───────────────────────────────────
const answers = [
  'There were 412 FIRs registered in Belagavi district in March 2026.',
  'PSI Meghana Yadav is the investigating officer on FIR 144011004202300002.',
  'Under Section 172 BNSS the case diary must record the time the information reached the officer, the time the investigation began and closed, and the places visited.',
  // Mentions "not available" but is a substantive answer, and long enough that
  // the length guard keeps it out of the negative bucket.
  'Three of the four accused were arrested on 12 March. The fourth, Ravi Kumar, is absconding; his current address is not available in the record, though the last known one is in Hubballi and a lookout notice has been issued through the district control room.',
];
answers.forEach((t) =>
  check(`sources kept for: "${t.slice(0, 48)}…"`, shown(t, SRC).length === 1));

// ── The specific regression ───────────────────────────────────────────────
// The ZCQL "unanswerable" branch used to cite the Data Store precisely BECAUSE
// it found nothing.
check('a ZCQL unanswerable reply is not passed any citation',
  !/unanswerable[\s\S]{0,400}?attribution\.TYPES\.DATABASE_RECORD/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
