// Held-export lifecycle. Run: node functions/rag/exportholds.test.js
//
// These tests attack the approval rather than exercise it. Every guard in
// release() and decide() exists because of a specific way the control could be
// walked around, so each one is tried here as an attacker would try it:
// approve your own export, redeem someone else's approval, swap the document
// after approval, redeem twice, redeem a rejection.
//
// A fake bucket stands in for Stratus — the module only needs getObject /
// putObject / listPagedObjects, and running against the real thing would make
// this suite need credentials the CI runner does not have.
const holds = require('./exportholds');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

function fakeBucket() {
  const store = new Map();
  return {
    store,
    async putObject(key, buf) { store.set(key, Buffer.from(buf).toString('utf8')); },
    async getObject(key) {
      if (!store.has(key)) throw new Error('NoSuchKey');
      return store.get(key);
    },
    async listPagedObjects({ prefix }) {
      const contents = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ keyDetails: { key: k } }));
      return { contents, truncated: 'false' };
    },
  };
}

const REQ = {
  email: 'kumar@ksp.gov.in', name: 'S Kumar', role: 'investigator',
  kind: 'report-studio', title: 'Charge Sheet — 412/2026',
  reasons: [{ category: 'minor', label: 'Minor / juvenile', why: 'w', evidence: 'minor victim' }],
  fingerprint: 'a'.repeat(64),
  stats: { phones: 2 },
};

const run = async () => {
  // ── Creation ─────────────────────────────────────────────────────────────
  const b = fakeBucket();
  const h = await holds.create(b, REQ);
  check('a new hold starts pending', h.status === 'pending');
  check('the hold records who asked', h.requestedBy === 'kumar@ksp.gov.in');
  check('the hold carries the reasons the supervisor must read', h.reasons.length === 1);
  check('the hold carries the content fingerprint', h.fingerprint === REQ.fingerprint);

  check(
    'the document itself is never stored',
    !JSON.stringify([...b.store.values()]).includes('BriefFacts'),
  );

  // Two officers exporting at the same moment must not overwrite each other —
  // this is the read-modify-write bug that has already cost this codebase a
  // conversation store and an audit index.
  const [h1, h2] = await Promise.all([holds.create(b, REQ), holds.create(b, { ...REQ, email: 'rao@ksp.gov.in' })]);
  check('concurrent creates both survive', h1.id !== h2.id && (await holds.get(b, h1.id)) && (await holds.get(b, h2.id)));

  // ── The queue ────────────────────────────────────────────────────────────
  const pending = await holds.list(b, { status: 'pending' });
  check('all three sit in the pending queue', pending.length === 3);
  check('oldest waits at the front', pending[0].requestedAt <= pending[1].requestedAt);

  // ── Dual control ─────────────────────────────────────────────────────────
  let selfApprove = null;
  try {
    await holds.decide(b, h.id, { decision: 'approved', approverEmail: 'kumar@ksp.gov.in', approverName: 'S Kumar' });
  } catch (e) { selfApprove = e; }
  check('an officer cannot approve their own export', selfApprove && selfApprove.code === 403, String(selfApprove));

  const decided = await holds.decide(b, h.id, {
    decision: 'approved', approverEmail: 'RAO@ksp.gov.in', approverName: 'A Rao', note: 'CWC copy authorised',
  });
  check('a second officer can approve', decided.status === 'approved');
  check('the approver is recorded', decided.decidedBy === 'rao@ksp.gov.in');
  check('the approver’s note is kept', decided.note === 'CWC copy authorised');

  let twice = null;
  try {
    await holds.decide(b, h.id, { decision: 'rejected', approverEmail: 'other@ksp.gov.in' });
  } catch (e) { twice = e; }
  check('a decided hold cannot be re-decided', twice && twice.code === 409, String(twice));

  check('an approved hold leaves the pending queue', (await holds.list(b, { status: 'pending' })).length === 2);

  // ── Redeeming ────────────────────────────────────────────────────────────
  const wrongOfficer = await holds.release(b, h.id, { email: 'rao@ksp.gov.in', fingerprint: REQ.fingerprint });
  check('another officer cannot redeem the approval', !wrongOfficer.ok, wrongOfficer.reason);

  const swapped = await holds.release(b, h.id, { email: 'kumar@ksp.gov.in', fingerprint: 'b'.repeat(64) });
  check('a swapped document is refused', !swapped.ok, swapped.reason);
  check('and the refusal says why', /changed since it was approved/.test(swapped.reason));

  const ok = await holds.release(b, h.id, { email: 'kumar@ksp.gov.in', fingerprint: REQ.fingerprint });
  check('the right officer with the right document is released', ok.ok, ok.reason);

  const reused = await holds.release(b, h.id, { email: 'kumar@ksp.gov.in', fingerprint: REQ.fingerprint });
  check('an approval is single-use', !reused.ok && /already been used/.test(reused.reason), reused.reason);

  // ── Rejection ────────────────────────────────────────────────────────────
  await holds.decide(b, h1.id, {
    decision: 'rejected', approverEmail: 'rao@ksp.gov.in', approverName: 'A Rao', note: 'Redact the witness first',
  });
  const rej = await holds.release(b, h1.id, { email: 'kumar@ksp.gov.in', fingerprint: REQ.fingerprint });
  check('a rejected export cannot be released', !rej.ok, rej.reason);
  check('the officer is told the reason for rejection', /Redact the witness first/.test(rej.reason));

  // ── Expiry ───────────────────────────────────────────────────────────────
  const stale = await holds.create(b, REQ);
  const raw = JSON.parse(b.store.get(`${holds.HOLD_PREFIX}${stale.id}.json`));
  raw.requestedAt = Date.now() - holds.PENDING_TTL_MS - 1000;
  b.store.set(`${holds.HOLD_PREFIX}${stale.id}.json`, JSON.stringify(raw));
  check('a forgotten request expires', (await holds.get(b, stale.id)).status === 'expired');
  check('and drops out of the pending queue', !(await holds.list(b, { status: 'pending' })).some((r) => r.id === stale.id));

  const unusedApproval = await holds.create(b, REQ);
  await holds.decide(b, unusedApproval.id, { decision: 'approved', approverEmail: 'rao@ksp.gov.in' });
  const ua = JSON.parse(b.store.get(`${holds.HOLD_PREFIX}${unusedApproval.id}.json`));
  ua.decidedAt = Date.now() - holds.APPROVAL_TTL_MS - 1000;
  b.store.set(`${holds.HOLD_PREFIX}${unusedApproval.id}.json`, JSON.stringify(ua));
  const expiredRelease = await holds.release(b, unusedApproval.id, {
    email: 'kumar@ksp.gov.in', fingerprint: REQ.fingerprint,
  });
  check('an unused approval does not stay redeemable forever', !expiredRelease.ok, expiredRelease.reason);

  // ── Bad input ────────────────────────────────────────────────────────────
  check('an unknown id is not found', (await holds.get(b, 'exp_nope')) === null);
  check('a path-traversal id is rejected outright', (await holds.get(b, '../../roles')) === null);
  const missing = await holds.release(b, 'exp_nope', { email: 'kumar@ksp.gov.in', fingerprint: 'x' });
  check('releasing an unknown id fails closed', !missing.ok);

  let badDecision = null;
  try { await holds.decide(b, h2.id, { decision: 'maybe', approverEmail: 'rao@ksp.gov.in' }); }
  catch (e) { badDecision = e; }
  check('an invalid decision is rejected', badDecision && badDecision.code === 400);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
