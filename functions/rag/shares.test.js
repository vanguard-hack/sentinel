// Sharing a diary or a report. Run: node functions/rag/shares.test.js
//
// The thing worth testing here is not the happy path — it is that two officers
// sharing at the same moment do not erase each other, that a withdrawn share
// stays on the record rather than vanishing, and that the two copies of every
// share (the recipient's and the sender's) stay honest about each other.
const shares = require('./shares');

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
      return {
        contents: [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ keyDetails: { key: k } })),
        truncated: 'false',
      };
    },
  };
}

const RAO = 'rao@ksp.gov.in';
const KUMAR = 'kumar@ksp.gov.in';
const DEVI = 'devi@ksp.gov.in';

const send = (b, over = {}) => shares.create(b, {
  kind: 'diary', docId: '197', title: 'Case Diary — 412/2026',
  from: RAO, fromName: 'A Rao', recipients: [KUMAR], note: 'Look at the seizure memo.',
  ...over,
});

(async () => {
  const b = fakeBucket();

  // ── Sending ─────────────────────────────────────────────────────────────
  const out = await send(b);
  check('a share reaches its recipient', out.sent.length === 1 && out.sent[0].to === KUMAR);
  check('the note travels with it', out.sent[0].note === 'Look at the seizure memo.');
  check('the sender is recorded by name as well as address',
    out.sent[0].from === RAO && out.sent[0].fromName === 'A Rao');

  const box = await shares.inbox(b, KUMAR);
  check('it appears in the recipient\'s inbox', box.length === 1);
  check('  and is unread to begin with', shares.unreadCount(box) === 1 && box[0].readAt === null);
  check('the sender sees who it went to',
    (await shares.forDoc(b, 'diary', '197')).map((r) => r.to).includes(KUMAR));
  check('it does NOT appear in an unrelated officer\'s inbox',
    (await shares.inbox(b, DEVI)).length === 0);

  // ── Several at once, which is the shape that races ──────────────────────
  const many = await send(b, { recipients: [KUMAR, DEVI, RAO, DEVI] });
  check('duplicate recipients are collapsed', many.sent.filter((r) => r.to === DEVI).length === 1);
  check('sending to yourself is skipped rather than failing the whole share',
    many.sent.length === 2 && many.skipped.some((s) => s.email === RAO),
    JSON.stringify(many.skipped));
  check('  and the reason is stated', /that is you/.test(many.skipped[0]?.why || ''));

  // One object per share, so two shares written at the same instant cannot
  // overwrite one another — the failure this codebase has shipped twice.
  const keys = [...b.store.keys()];
  check('every share is its own object, never an array rewritten in place',
    keys.filter((k) => k.startsWith(shares.TO_PREFIX)).length === 3,
    String(keys.filter((k) => k.startsWith(shares.TO_PREFIX)).length));
  check('and each is written under both the recipient and the document',
    keys.filter((k) => k.startsWith(shares.DOC_PREFIX)).length === 3);

  // ── Reading ─────────────────────────────────────────────────────────────
  const first = (await shares.inbox(b, KUMAR))[0];
  await shares.markRead(b, KUMAR, first.id);
  check('marking read clears it from the unread count',
    shares.unreadCount(await shares.inbox(b, KUMAR)) === 1,
    'one of the two shares to Kumar should still be unread');

  let notMine = null;
  try { await shares.markRead(b, DEVI, first.id); } catch (e) { notMine = e; }
  check('one officer cannot mark another\'s share read', !!notMine,
    'the unread badge would be a fiction');

  // ── Withdrawing ─────────────────────────────────────────────────────────
  let wrongHands = null;
  try { await shares.revoke(b, KUMAR, first.id, KUMAR); } catch (e) { wrongHands = e; }
  check('only the sender can withdraw a share', !!wrongHands, wrongHands && wrongHands.message);

  await shares.revoke(b, RAO, first.id, KUMAR);
  check('a withdrawn share leaves the inbox',
    !(await shares.inbox(b, KUMAR)).some((r) => r.id === first.id));
  check('  and leaves the sender\'s view of the document too',
    !(await shares.forDoc(b, 'diary', '197')).some((r) => r.id === first.id));
  check('  but is still on the record rather than deleted',
    (await shares.inbox(b, KUMAR, { includeRevoked: true })).some((r) => r.id === first.id && r.revokedAt),
    '"sent then withdrew" is exactly what an audit trail exists to still know');

  // ── Refusals ────────────────────────────────────────────────────────────
  const refuses = async (over, why) => {
    try { await send(b, over); return false; } catch { return true; }
  };
  check('an unknown document kind is refused', await refuses({ kind: 'payroll' }));
  check('a missing document id is refused', await refuses({ docId: '' }));
  check('no recipients is refused', await refuses({ recipients: [] }));
  check('a missing sender is refused', await refuses({ from: '' }));
  check('more than the cap is refused',
    await refuses({ recipients: Array.from({ length: shares.MAX_RECIPIENTS + 1 }, (_, i) => `o${i}@ksp.gov.in`) }));
  check('blank recipients are dropped rather than counted',
    (await send(b, { recipients: ['', '  ', DEVI] })).sent.length === 1);

  // An address is a path segment. Anything that could climb out of the prefix
  // is removed, or a share lands in a directory it was never meant for.
  const odd = await send(b, { recipients: ['../../admin@ksp.gov.in'] });
  const oddKey = [...b.store.keys()].find((k) => k.includes('admin@ksp.gov.in'));
  check('an address cannot climb out of its prefix',
    oddKey && oddKey.startsWith(shares.TO_PREFIX) && !oddKey.includes('..'),
    oddKey);
  check('  and the share still went somewhere sane', odd.sent.length === 1);

  const longNote = await send(b, { note: 'x'.repeat(5000) });
  check('an oversized note is truncated rather than stored whole',
    longNote.sent[0].note.length === shares.MAX_NOTE);

  // ── Reports share the same machinery ────────────────────────────────────
  const rpt = await shares.create(b, {
    kind: 'report', docId: 'RPT-2026-0007', title: 'Final Report',
    from: RAO, fromName: 'A Rao', recipients: [DEVI],
  });
  check('a report shares the same way a diary does', rpt.sent.length === 1);
  check('  and the two kinds do not collide in the inbox',
    (await shares.inbox(b, DEVI)).some((r) => r.kind === 'report')
    && (await shares.inbox(b, DEVI)).some((r) => r.kind === 'diary'));
  check('  or in the per-document view',
    (await shares.forDoc(b, 'report', 'RPT-2026-0007')).length === 1
    && (await shares.forDoc(b, 'diary', 'RPT-2026-0007')).length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
