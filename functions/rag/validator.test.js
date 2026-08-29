#!/usr/bin/env node
/* ZCQL validator tests. Run: node functions/rag/validator.test.js
 *
 * The validator is the gate between a model-generated query and the database,
 * so these are adversarial by design: each case is something an injected
 * prompt might realistically emit. It must fail closed — reject with a reason
 * rather than rewrite into something that merely looks safe.
 */
const assert = require('assert');
const { validateZcql, MAX_ROWS } = require('./zcql.js');

const cases = [
  // [name, query, shouldPass]
  ['filtered select', "SELECT CrimeNo FROM CaseMaster WHERE CaseStatusID = 1", true],
  ['aggregate needs no limit', 'SELECT COUNT(ROWID) FROM CaseMaster', true],
  ['literal containing a keyword is data, not syntax',
    "SELECT * FROM CaseMaster WHERE BriefFacts = 'join the gang'", true],
  ['harmless comment', 'SELECT * FROM CaseMaster /* note */ WHERE 1=1', true],

  ['comma cross-join smuggles a second table', 'SELECT * FROM CaseMaster, Accused', false],
  ['explicit join', 'SELECT * FROM CaseMaster JOIN Accused ON x = y', false],
  ['mutation', 'UPDATE CaseMaster SET CaseStatusID = 2', false],
  ['stacked statement', 'SELECT * FROM CaseMaster; DELETE FROM Accused', false],
  ['subquery reaches another table', 'SELECT * FROM CaseMaster WHERE x IN (SELECT y FROM Accused)', false],
  ['union past a line comment', 'SELECT * FROM CaseMaster WHERE 1=1 --\nUNION SELECT * FROM Accused', false],
  ['unfiltered scan with no limit', 'SELECT CrimeNo FROM CaseMaster', false],
  ['unterminated literal', "SELECT * FROM CaseMaster WHERE x = 'oops", false],
  ['empty', '', false],
  ['DDL', 'DROP TABLE CaseMaster', false],
];

let failures = 0;
for (const [name, q, shouldPass] of cases) {
  const r = validateZcql(q);
  try {
    assert.strictEqual(r.ok, shouldPass, `${name}: expected ok=${shouldPass}, got ${r.ok} (${r.error || 'passed'})`);
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL ${name} — ${e.message}`);
  }
}

// A filtered query without a LIMIT gets one; it is never left unbounded.
const capped = validateZcql('SELECT CrimeNo FROM CaseMaster WHERE CaseStatusID = 1');
assert.ok(new RegExp(`LIMIT 0, ${MAX_ROWS}$`).test(capped.query), 'limit should be appended');
console.log('  ok  a filtered query is capped automatically');

// An oversized LIMIT is clamped rather than accepted.
const clamped = validateZcql('SELECT CrimeNo FROM CaseMaster WHERE x = 1 LIMIT 0, 99999');
assert.ok(clamped.ok && clamped.query.endsWith(`LIMIT 0, ${MAX_ROWS}`), 'oversized limit should clamp');
console.log('  ok  an oversized LIMIT is clamped');

// Decisions are recorded so the audit trail can show what was checked.
assert.ok(Array.isArray(capped.checks) && capped.checks.length > 3, 'checks should be recorded');
assert.ok(validateZcql('SELECT * FROM A, B').checks.some((c) => c.startsWith('FAIL:')), 'failures recorded');
console.log('  ok  validator decisions are recorded for audit');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log(`\nAll ${cases.length + 3} validator checks passed.`);
