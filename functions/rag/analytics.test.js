/* The analytics snapshot — the contract the browser decodes against.
 *
 * This replaced 437 paged browser requests with one response per table, and
 * two things in it fail silently if they drift:
 *
 *  1. COLUMN ORDER. The payload is columnar, so the client rebuilds each row by
 *     zipping `cols` against the value array. A column reordered on one side
 *     and not the other yields rows where every field holds its neighbour's
 *     value — no error, just wrong charts.
 *
 *  2. ALIASES. CaseLinkageExtra reads CaseMaster under a different key. If the
 *     alias stops resolving, case linkage loses the coordinates and BriefFacts
 *     its whole similarity model runs on, and quietly scores everything zero.
 */
const A = require('./analytics');

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`ok  ${name}`); } else { fail += 1; console.log(`FAIL ${name}`); }
};

// ── the table spec ──────────────────────────────────────────────────────────
check('every analytics page has its table in the spec',
  ['CaseMaster', 'Accused', 'Victim', 'ArrestSurrender', 'Unit', 'District',
    'CrimeHead', 'CrimeSubHead', 'CaseStatusMaster', 'Court', 'ChargesheetDetails',
    'ActSectionAssociation', 'ComplainantDetails', 'Employee']
    .every((t) => !!A.specOf(t)));

check('an unknown table resolves to nothing rather than throwing',
  A.specOf('DoesNotExist') === null);

for (const key of Object.keys(A.TABLES)) {
  const spec = A.specOf(key);
  check(`${key}: resolves to a real table and column list`,
    !!spec && typeof spec.from === 'string' && Array.isArray(spec.cols) && spec.cols.length > 0);
  check(`${key}: no duplicate columns`,
    new Set(spec.cols).size === spec.cols.length);
  // Every row is keyed back to a case (or is a master table keyed by its own id).
  check(`${key}: carries a join key`,
    spec.cols.some((c) => /ID$/i.test(c)));
}

// ── aliases ─────────────────────────────────────────────────────────────────
const extra = A.specOf('CaseLinkageExtra');
check('CaseLinkageExtra reads from CaseMaster', extra.from === 'CaseMaster');
check('CaseLinkageExtra carries the columns case linkage needs',
  ['latitude', 'longitude', 'BriefFacts'].every((c) => extra.cols.includes(c)));
check('CaseLinkageExtra can be joined back to the case rows',
  extra.cols.includes('CaseMasterID'));

// The 4 MB of free text is the whole reason this is a separate entry.
check('BriefFacts is NOT in the shared CaseMaster payload',
  !A.specOf('CaseMaster').cols.includes('BriefFacts'));
check('coordinates are not in the shared CaseMaster payload either',
  !A.specOf('CaseMaster').cols.some((c) => /latitude|longitude/.test(c)));

// ── cache keys ──────────────────────────────────────────────────────────────
check('each table caches under its own key',
  A.SNAPSHOT_KEY('CaseMaster') !== A.SNAPSHOT_KEY('Accused'));
check('the alias caches separately from the table it reads',
  A.SNAPSHOT_KEY('CaseLinkageExtra') !== A.SNAPSHOT_KEY('CaseMaster'));
check('the key is versioned, so a re-import can invalidate every snapshot',
  A.SNAPSHOT_KEY('CaseMaster').includes(`v${A.SNAPSHOT_VERSION}`));
check('the key stays inside the analytics prefix',
  Object.keys(A.TABLES).every((t) => A.SNAPSHOT_KEY(t).startsWith('analytics/')));

// ── the read loop ───────────────────────────────────────────────────────────
// A failed page must NOT be read as the end of the table: that would truncate
// the snapshot and every chart drawn from it, with nothing reported.
(async () => {
  const pageOf = (n) => Array.from({ length: n }, (_, i) => ({ CaseMaster: { CaseMasterID: i } }));
  const fakeApp = (behaviour) => ({ zcql: () => ({ executeZCQLQuery: behaviour }) });

  const short = await A.readTable(
    fakeApp(async (q) => (/LIMIT 0,/.test(q) ? pageOf(300) : pageOf(7))),
    'CaseMaster', ['CaseMasterID']
  );
  check('a short page ends the read', short.length === 307);

  let threw = false;
  try {
    await A.readTable(
      fakeApp(async (q) => { if (/LIMIT 600,/.test(q)) throw new Error('boom'); return pageOf(300); }),
      'CaseMaster', ['CaseMasterID']
    );
  } catch { threw = true; }
  check('a failed page throws rather than silently truncating', threw);

  const missing = await A.readTable(
    fakeApp(async () => [{ CaseMaster: { CaseMasterID: 1 } }]),
    'CaseMaster', ['CaseMasterID', 'CrimeNo']
  );
  check('an absent column becomes null, keeping every row the same width',
    missing[0].length === 2 && missing[0][1] === null);

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail) process.exit(1);
})();
