// The one-time purge of demonstration diaries.
// Run: node functions/rag/purgeseeded.test.js
//
// This deletes case records, and a deletion cannot be walked back. The whole
// safety argument is that it can only ever touch a record stamped seeded:true,
// so that is what gets tested — against the real handler, not a paraphrase of
// it: the source is lifted out of index.js and run with its dependencies
// injected and a fake bucket standing in for Stratus.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`could not find ${from}`);
  return src.slice(a, b);
};

const DEPS = ['readBody', 'catalystSDK', 'CONV_BUCKET', 'myRole', 'json', 'loadInvIndex',
  'streamToString', 'invKey', 'saveInvIndex', 'INV_PERSON_INDEX_KEY', 'storeAuditEvents'];
const body = cut('const isSeededRecord =', '\nasync function handleInvestigation(req, res, action) {');
// eslint-disable-next-line no-new-func
const build = new Function(...DEPS, `${body}\nreturn { isSeededRecord, handleInvestigationPurgeSeeded };`);

// ── A fake Stratus bucket ──────────────────────────────────────────────────
function makeBucket(objects) {
  const store = new Map(Object.entries(objects));
  const deleted = [];
  return {
    store,
    deleted,
    async getObject(key) {
      if (!store.has(key)) throw new Error('no such object: ' + key);
      const v = store.get(key);
      if (v === '<<unreadable>>') throw new Error('read failed');
      return v;
    },
    async putObject(key, buf) { store.set(key, String(buf)); },
    async deleteObject(key) {
      if (!store.has(key)) throw new Error('no such object: ' + key);
      store.delete(key);
      deleted.push(key);
    },
  };
}

const INV_PREFIX = 'investigation/diary/';
const PIDX = 'investigation/persons-index.json';

function run({ role = 'admin', caller = { email_id: 'a@b.c' }, confirm, records, index, persons }) {
  const bucket = makeBucket({
    ...Object.fromEntries(Object.entries(records).map(([id, r]) => [`${INV_PREFIX}${id}.json`, JSON.stringify(r)])),
    ...(persons ? { [PIDX]: JSON.stringify(persons) } : {}),
  });
  let savedIndex = null;
  const audits = [];
  const api = build(
    async () => JSON.stringify(confirm === undefined ? {} : { confirm }),
    { initialize: () => ({ stratus: () => ({ bucket: () => bucket }) }) },
    'bucket',
    async () => ({ role, caller }),
    (res, status, payload) => ({ status, payload }),
    async () => index,
    async (v) => (typeof v === 'string' ? v : String(v)),
    (id) => `${INV_PREFIX}${id}.json`,
    async (_b, cases) => { savedIndex = cases; },
    PIDX,
    async (_req, _app, _b, events) => { audits.push(...events); },
  );
  return { api, bucket, audits, out: api.handleInvestigationPurgeSeeded({}, {}), savedIndex: () => savedIndex };
}

// ── isSeededRecord ─────────────────────────────────────────────────────────
const { isSeededRecord } = build(...DEPS.map(() => undefined));
check('a seeded record matches', isSeededRecord({ seeded: true }));
check('a diary an officer filed does not', !isSeededRecord({ crimeNo: '1/2026' }));
check('a missing record does not', !isSeededRecord(null));
check('seeded:false does not', !isSeededRecord({ seeded: false }));
check('the string "true" does NOT match — only the boolean stamp',
  !isSeededRecord({ seeded: 'true' }));

(async () => {
  const index = [
    { caseMasterId: '1', crimeNo: 'A/1' },
    { caseMasterId: '2', crimeNo: 'B/2' },
    { caseMasterId: '3', crimeNo: 'C/3' },
    { caseMasterId: '4', crimeNo: 'D/4' },
  ];
  const records = {
    1: { caseMasterId: '1', seeded: true },
    2: { caseMasterId: '2' },                 // an officer's real diary
    3: { caseMasterId: '3', seeded: true },
    4: '<<unreadable>>',                      // blob that will not read
  };
  const persons = {
    people: {
      'ramesh kumar': [{ caseMasterId: '1', name: 'Ramesh Kumar' }],
      'shared name': [{ caseMasterId: '1' }, { caseMasterId: '2' }],
      'real witness': [{ caseMasterId: '2' }],
    },
  };

  // ── Dry run ──────────────────────────────────────────────────────────────
  {
    const r = run({ records, index, persons });
    const { payload } = await r.out;
    check('without confirm it is a dry run', payload.dryRun === true);
    check('  it names what it would delete', payload.matched === 2
      && payload.cases.map((c) => c.caseMasterId).join(',') === '1,3', JSON.stringify(payload.cases));
    check('  and deletes nothing', r.bucket.deleted.length === 0);
    check('  and does not rewrite the index', r.savedIndex() === null);
    check('  and writes no audit event', r.audits.length === 0);
  }

  // ── Confirmed run ────────────────────────────────────────────────────────
  {
    const r = run({ records, index, persons, confirm: true });
    const { payload } = await r.out;
    check('with confirm it deletes the seeded diaries', payload.deleted === 2);
    check('  exactly those two blobs are gone',
      r.bucket.deleted.sort().join(',') === `${INV_PREFIX}1.json,${INV_PREFIX}3.json`,
      r.bucket.deleted.join(','));
    check("  an officer's diary is untouched", r.bucket.store.has(`${INV_PREFIX}2.json`));
    check('  a blob that would not read is left alone', r.bucket.store.has(`${INV_PREFIX}4.json`));
    check('  the index keeps the survivors, in order',
      r.savedIndex().map((c) => c.caseMasterId).join(',') === '2,4',
      JSON.stringify(r.savedIndex()));

    const pidx = JSON.parse(r.bucket.store.get(PIDX));
    check('  a name known only to a deleted case is dropped', !pidx.people['ramesh kumar']);
    check('  a name shared with a live case survives, minus the dead reference',
      pidx.people['shared name'].length === 1 && pidx.people['shared name'][0].caseMasterId === '2',
      JSON.stringify(pidx.people['shared name']));
    check('  an untouched name is untouched', pidx.people['real witness'].length === 1);
    check('  the deletion is audited by crime number',
      r.audits.length === 1 && /A\/1, C\/3/.test(r.audits[0].detail), JSON.stringify(r.audits));
  }

  // ── Nothing to do ────────────────────────────────────────────────────────
  {
    const r = run({ records: { 2: { caseMasterId: '2' } }, index: [{ caseMasterId: '2' }], confirm: true });
    const { payload } = await r.out;
    check('a deployment with no seeded diaries deletes nothing', payload.deleted === 0);
    check('  and says so rather than reporting a successful purge', /No seeded diaries remain/.test(payload.note));
    check('  and leaves the index alone', r.savedIndex() === null);
  }

  // ── Who may run it ───────────────────────────────────────────────────────
  for (const role of ['investigator', 'supervisor', 'analyst', 'policymaker']) {
    const r = run({ role, records, index, confirm: true });
    const { status } = await r.out;
    check(`a ${role} cannot purge`, status === 403);
    check(`  and nothing is deleted for a ${role}`, r.bucket.deleted.length === 0);
  }
  {
    const r = run({ role: 'admin', caller: null, records, index, confirm: true });
    const { status } = await r.out;
    check('an unauthenticated caller cannot purge', status === 403);
    check('  and nothing is deleted for them', r.bucket.deleted.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
