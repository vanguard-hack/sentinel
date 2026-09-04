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
  // Every row is keyed back to a case, or is a reference table keyed by its own
  // identifier. The legal tables key on a CODE rather than an ID (ActCode,
  // SectionCode), which is the CCTNS spelling, so both count.
  check(`${key}: carries a join key`,
    spec.cols.some((c) => /(ID|Code|_id)$/i.test(c)));
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


// ── the client contract ─────────────────────────────────────────────────────
// The home page broke in production because CaseCategory was dropped from the
// spec while reports.js still asked for it: the request 400s, the page renders
// an error and nothing else. Reading the actual call sites is the only check
// that catches this, since nothing else connects the two files.
const fs = require('fs');
const path = require('path');

const UTILS = path.join(__dirname, '..', '..', 'react-app', 'src', 'utils');
if (fs.existsSync(UTILS)) {
  const wanted = new Set();
  for (const f of fs.readdirSync(UTILS).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(UTILS, f), 'utf8');
    for (const re of [/fetchSnapshotTable\('([A-Za-z_]+)'\)/g,
      /\blookup\('([A-Za-z_]+)'/g, /\bmapOf\('([A-Za-z_]+)'/g]) {
      let m;
      while ((m = re.exec(src)) !== null) wanted.add(m[1]);
    }
  }
  const missing = [...wanted].filter((t) => !A.specOf(t)).sort();
  check(`every table the client requests is in the spec${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
    missing.length === 0);
  check('the client actually requests something (the scan works)', wanted.size > 5);
}

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

  // The failure the home page actually hit. A Development datastore refuses
  // pages under load — eight tables building at once is ~100 queries in
  // flight — and the first version treated one refusal as the end of the
  // build, so 95 good pages were thrown away and the officer got
  // "page read failed" where the bento should be.
  let attempts = 0;
  const flaky = await A.readTable(
    fakeApp(async (q) => {
      if (/LIMIT 600,/.test(q)) {
        attempts += 1;
        if (attempts <= 2) throw new Error('R00004: too many concurrent requests');
      }
      return /LIMIT 2400,/.test(q) ? pageOf(11) : pageOf(300);
    }),
    'CaseMaster', ['CaseMasterID']
  );
  check('a page refused twice is retried, not treated as the end of the table',
    flaky.length === 8 * 300 + 11 && attempts === 3);

  let threw = null;
  try {
    await A.readTable(
      fakeApp(async (q) => { if (/LIMIT 600,/.test(q)) throw new Error('R00004: refused'); return pageOf(300); }),
      'CaseMaster', ['CaseMasterID']
    );
  } catch (e) { threw = e; }
  check('a page that never recovers still throws rather than silently truncating', !!threw);
  // "page read failed" was all the old message said, which is how a throttle
  // and a dropped column looked identical from the browser. The message must
  // name the table, the rows, and the store's own reason.
  check('the failure carries the store\'s own reason, not just "failed"',
    threw && /CaseMaster/.test(threw.message) && /600/.test(threw.message)
      && /R00004: refused/.test(threw.message));
  check('the failure says how many tries it took',
    threw && new RegExp(`${A.RETRIES + 1} tries`).test(threw.message));

  // Retrying is bounded in time as well as in tries: past the budget the build
  // gives up at once instead of sleeping its way into being killed by the
  // function's own clock, which would tell the browser nothing at all.
  const t0 = Date.now();
  let budgeted = null;
  try {
    await A.readTable(
      fakeApp(async () => { throw new Error('R00004: refused'); }),
      'CaseMaster', ['CaseMasterID'], { budgetMs: 0 }
    );
  } catch (e) { budgeted = e; }
  check('past the budget the build gives up rather than sleeping through it',
    !!budgeted && Date.now() - t0 < 500);

  const missing = await A.readTable(
    fakeApp(async () => [{ CaseMaster: { CaseMasterID: 1 } }]),
    'CaseMaster', ['CaseMasterID', 'CrimeNo']
  );
  check('an absent column becomes null, keeping every row the same width',
    missing[0].length === 2 && missing[0][1] === null);

  /* The spec must name columns that EXIST.
   *
   * A wrong column name is not a slow failure: every page of that table is
   * rejected, so the build dies on its first wave and the page that reads it
   * shows an error instead of a chart. SCHEMA.md is generated from the same
   * dataset the Data Store is imported from, so it is the one place in the
   * repo that can answer whether a column is real. */
  const fs = require('fs');
  const path = require('path');
  const mdPath = path.join(__dirname, '..', '..', 'ksp', 'fir', 'import', 'SCHEMA.md');
  if (fs.existsSync(mdPath)) {
    const schema = {};
    let cur = null;
    for (const line of fs.readFileSync(mdPath, 'utf8').split('\n')) {
      const h = line.match(/^##\s+`([A-Za-z_]+)`/);
      if (h) { cur = h[1]; schema[cur] = new Set(); continue; }
      if (/^##/.test(line)) { cur = null; continue; }
      if (!cur) continue;
      const c = line.match(/^\|\s*([A-Za-z_][A-Za-z0-9_]*)\s*\|/);
      if (c && c[1] !== 'Column') schema[cur].add(c[1]);
    }
    check('SCHEMA.md parsed', Object.keys(schema).length > 20);
    for (const key of Object.keys(A.TABLES)) {
      const { from, cols } = A.specOf(key);
      const cols_ = schema[from];
      const bad = cols_ ? cols.filter((c) => !cols_.has(c)) : ['<no such table>'];
      check(`${key}: every column exists in ${from}${bad.length ? ` (missing ${bad.join(', ')})` : ''}`,
        bad.length === 0);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail) process.exit(1);
})();
