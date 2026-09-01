// Audit tamper-evidence. Run: node functions/rag/integrity.test.js
//
// A detector nobody has attacked is a decoration, so these tests do the
// tampering themselves — edit an entry, delete a file, backdate one into a
// closed day, rewrite a seal — and assert each is CAUGHT and NAMED correctly.
//
// Two failures are treated as seriously as a miss:
//   • calling an entry altered when it was only written before hashing existed;
//   • calling the log intact when nothing in it could actually be checked.
// Both are the verifier lying, and a verifier that lies is worse than none.
const integrity = require('./integrity');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const clone = (v) => JSON.parse(JSON.stringify(v));

const EVENTS = [
  { ts: 1756000000000, email: 'kumar@ksp.gov.in', role: 'investigator', feature: 'Case Files',
    action: 'view', path: '/case-files', detail: 'Case 412/2026', ip: '10.1.2.3', location: 'Bengaluru' },
  { ts: 1756000060000, email: 'rao@ksp.gov.in', role: 'supervisor', feature: 'Access & Audit',
    action: 'export-csv', path: '/access', detail: '120 events', ip: '10.1.2.9', location: 'Mysuru' },
];

// ── Canonicalisation ───────────────────────────────────────────────────────
// The hash must depend on what an event SAYS, not on the order the writer
// happened to build the object in — otherwise refactoring writeAuditEvents
// silently invalidates every fingerprint already in Stratus.
check('key order does not change the hash',
  integrity.hashEvents([{ a: 1, b: 2 }]) === integrity.hashEvents([{ b: 2, a: 1 }]));
check('nested key order does not change it either',
  integrity.hashEvents([{ x: { p: 1, q: 2 } }]) === integrity.hashEvents([{ x: { q: 2, p: 1 } }]));
check('an absent field and an explicitly null one hash differently',
  integrity.hashEvents([{ a: 1 }]) !== integrity.hashEvents([{ a: 1, b: null }]));
check('an empty string is not the same as null',
  integrity.hashEvents([{ a: '' }]) !== integrity.hashEvents([{ a: null }]));
check('different content gives a different hash',
  integrity.hashEvents(EVENTS) !== integrity.hashEvents([EVENTS[0]]));
check('the same content gives the same hash every time',
  integrity.hashEvents(EVENTS) === integrity.hashEvents(clone(EVENTS)));

// ── Level 1: one audit file against its own fingerprint ────────────────────
const sealed = { events: EVENTS, integrity: integrity.sealBlob(EVENTS) };
check('an untouched file verifies', integrity.verifyBlob('k1', sealed).status === 'intact');

const edited = clone(sealed);
edited.events[0].detail = 'Case 999/2026';        // the quiet correction
check('editing one entry is caught', integrity.verifyBlob('k1', edited).status === 'altered');

const removed = clone(sealed);
removed.events.splice(0, 1);                       // the deleted line
check('removing an entry from a file is caught', integrity.verifyBlob('k1', removed).status === 'altered');

check('a file written before hashing existed is UNVERIFIABLE, not altered',
  integrity.verifyBlob('k0', { events: EVENTS }).status === 'unverifiable');

// ── Level 2: the day seal ──────────────────────────────────────────────────
const fileA = { key: 'audit/logs/2026-08-30/1-aaa.json', blob: sealed };
const fileB = {
  key: 'audit/logs/2026-08-30/2-bbb.json',
  blob: (() => { const e = [EVENTS[1]]; return { events: e, integrity: integrity.sealBlob(e) }; })(),
};
const asSealEntries = (files) => files.map((f) => ({
  key: f.key, hash: f.blob.integrity.events, count: f.blob.events.length,
}));

const sealArgs = {
  day: '2026-08-30', prevSealHash: integrity.GENESIS, prevDay: null, seq: 1,
  sealedAt: '2026-08-31T00:05:00.000Z',
};
const seal = integrity.buildSeal({ ...sealArgs, blobs: asSealEntries([fileA, fileB]) });

check('a seal verifies its own hash', integrity.sealHashValid(seal));
check('listing the files in a different order gives the same seal',
  integrity.buildSeal({ ...sealArgs, blobs: asSealEntries([fileB, fileA]) }).sealHash === seal.sealHash);
check('the seal counts what it covers', seal.blobCount === 2 && seal.eventCount === 3);

const day = (blobs, s) => [{ day: '2026-08-30', blobs, seal: s }];
const kinds = (v) => v.problems.map((p) => p.kind);

check('a sealed, untouched day is intact', integrity.verify(day([fileA, fileB], seal)).intact);

// THE SCENARIO THIS EXISTS FOR: an inconvenient access is deleted wholesale.
// Without a seal the day would simply look like it had one fewer file.
const deleted = integrity.verify(day([fileB], seal));
check('deleting a whole file of entries is caught by the seal',
  kinds(deleted).includes('DELETED_FILE'));
check('and the finding names the file that went missing',
  deleted.problems.some((p) => p.key === fileA.key));

// Editing an entry AND rewriting that file's own fingerprint to match — the
// attack that defeats level 1 on its own.
const restamped = { key: fileA.key, blob: (() => {
  const e = clone(EVENTS); e[0].detail = 'Case 999/2026';
  return { events: e, integrity: integrity.sealBlob(e) };
})() };
const restampedVerdict = integrity.verify(day([restamped, fileB], seal));
check('rewriting a file AND its own fingerprint is still caught by the seal',
  kinds(restampedVerdict).includes('ALTERED_FILE'));
check('and it is not misreported as a self-inconsistent file',
  !kinds(restampedVerdict).includes('ALTERED_EVENT'));

// Adding an entry to a day that is already closed.
const fileC = {
  key: 'audit/logs/2026-08-30/3-ccc.json',
  blob: (() => { const e = [{ ts: 1, detail: 'inserted' }]; return { events: e, integrity: integrity.sealBlob(e) }; })(),
};
check('a file backdated into a sealed day is caught',
  kinds(integrity.verify(day([fileA, fileB, fileC], seal))).includes('BACKDATED_FILE'));

const forgedSeal = { ...clone(seal) };
forgedSeal.blobs = forgedSeal.blobs.filter((b) => b.key !== fileA.key);
check('rewriting the seal to cover the deletion is caught',
  kinds(integrity.verify(day([fileB], forgedSeal))).includes('ALTERED_SEAL'));

// ── Level 3: the seal chain ────────────────────────────────────────────────
const seal2 = integrity.buildSeal({
  day: '2026-08-31', blobs: asSealEntries([fileB]),
  prevSealHash: seal.sealHash, prevDay: '2026-08-30', seq: 2, sealedAt: '2026-09-01T00:05:00.000Z',
});
const twoDays = [
  { day: '2026-08-30', blobs: [fileA, fileB], seal },
  { day: '2026-08-31', blobs: [fileB], seal: seal2 },
];
check('consecutive seals link', integrity.verify(twoDays).intact);
check('the head hash is the newest seal', integrity.verify(twoDays).headHash === seal2.sealHash);

// Replace the first seal with one covering fewer files, then re-point nothing:
// the second seal still names the hash of the seal that WAS there.
const rewrittenFirst = integrity.buildSeal({ ...sealArgs, blobs: asSealEntries([fileB]) });
check('replacing an earlier seal breaks the link from the next one',
  kinds(integrity.verify([
    { day: '2026-08-30', blobs: [fileB], seal: rewrittenFirst },
    { day: '2026-08-31', blobs: [fileB], seal: seal2 },
  ])).includes('BROKEN_SEAL_LINK'));

// A range the admin did not ask for is not evidence of anything.
const seal5 = integrity.buildSeal({
  day: '2026-09-05', blobs: asSealEntries([fileB]),
  prevSealHash: 'f'.repeat(64), prevDay: '2026-09-04', seq: 5, sealedAt: '2026-09-06T00:00:00.000Z',
});
check('a gap in the seal sequence is NOT reported as tampering — those days were simply not loaded',
  integrity.verify([
    { day: '2026-08-30', blobs: [fileA, fileB], seal },
    { day: '2026-09-05', blobs: [fileB], seal: seal5 },
  ]).intact);

// ── Not crying wolf, and not falsely reassuring ────────────────────────────
const legacy = { key: 'audit/logs/2026-01-01/old.json', blob: { events: EVENTS } };
const legacyVerdict = integrity.verify([{ day: '2026-01-01', blobs: [legacy], seal: null }]);
check('a day of pre-integrity files raises no tamper alert', legacyVerdict.intact);
check('but those entries are counted as unverifiable, not verified',
  legacyVerdict.eventsUnverifiable === 2 && legacyVerdict.eventsVerified === 0);
check('and the summary says so rather than reading as a clean bill of health',
  /cannot be checked/i.test(integrity.summarise(legacyVerdict)));

const openDay = integrity.verify(day([fileA, fileB], null));
check('an unsealed day still verifies each file against its own fingerprint',
  openDay.intact && openDay.eventsVerified === 3);
check('an unsealed day is reported as still open',
  openDay.days[0].sealStatus === 'unsealed');
check('a failed check says what was wrong in words an admin can act on',
  /FAILED/.test(integrity.summarise(deleted)) && /removed/i.test(integrity.summarise(deleted)));
check('an empty range is not called intact-with-nothing-checked',
  /No audit entries/.test(integrity.summarise(integrity.verify([]))));

// ── The Stratus wiring, against a fake bucket ──────────────────────────────
//
// integrity.js is pure and well covered above; the part that can quietly break
// is index.js driving it — listing a day, deciding whether that day is closed,
// writing the seal, advancing the head pointer. This exercises those functions
// themselves rather than a copy of them.
const { _audit } = require('./index');

function fakeBucket() {
  const store = new Map();
  return {
    store,
    async putObject(key, buf) { store.set(key, Buffer.from(buf).toString('utf8')); },
    async getObject(key) {
      if (!store.has(key)) throw new Error('NoSuchKey: ' + key);
      return store.get(key);                       // streamToString accepts a string
    },
    async listPagedObjects({ prefix }) {
      const contents = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ keyDetails: { key: k } }));
      return { contents, truncated: 'false' };
    },
  };
}

/** Write an audit object exactly as writeAuditEvents does. */
const putAudit = async (bucket, day, name, events) => {
  const key = `${_audit.AUDIT_PREFIX}${day}/${name}.json`;
  await bucket.putObject(key, Buffer.from(JSON.stringify({ events, integrity: integrity.sealBlob(events) })));
  return key;
};

(async () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const today = _audit.utcDay();

  const bucket = fakeBucket();
  const kA = await putAudit(bucket, yesterday, '1-aaa', [EVENTS[0]]);
  await putAudit(bucket, yesterday, '2-bbb', [EVENTS[1]]);
  await putAudit(bucket, today, '3-ccc', [EVENTS[0]]);

  const dayFiles = await _audit.loadAuditDay(bucket, yesterday);
  check('a day loads every object under its prefix, with keys', dayFiles.length === 2);
  check('and only that day', !dayFiles.some((f) => f.key.includes(today)));

  const newSeal = await _audit.sealDayIfClosed(bucket, yesterday, dayFiles, {});
  check('a finished day gets sealed', !!newSeal && newSeal.seq === 1);
  check('the seal is stored under its own key', bucket.store.has(_audit.sealKey(yesterday)));
  check('the head pointer advances to it',
    JSON.parse(bucket.store.get(_audit.SEAL_HEAD_KEY)).sealHash === newSeal.sealHash);

  const todayFiles = await _audit.loadAuditDay(bucket, today);
  check('today is NOT sealed — its contents can still change',
    (await _audit.sealDayIfClosed(bucket, today, todayFiles, {})) === null);

  check('sealing is idempotent — a second pass returns the same seal',
    (await _audit.sealDayIfClosed(bucket, yesterday, dayFiles, {})).sealHash === newSeal.sealHash);

  check('a sealed day verifies clean through the real path',
    integrity.verify([{ day: yesterday, blobs: dayFiles, seal: newSeal }]).intact);

  // Now tamper the way an insider would: delete the object recording an
  // inconvenient access, straight out of the store.
  bucket.store.delete(kA);
  const after = integrity.verify([
    { day: yesterday, blobs: await _audit.loadAuditDay(bucket, yesterday), seal: newSeal },
  ]);
  check('deleting an audit object from Stratus is caught end to end',
    !after.intact && after.problems.some((p) => p.kind === 'DELETED_FILE' && p.key === kA));

  // And the subtler one: edit an entry in place, leaving the file present.
  const bucket2 = fakeBucket();
  const kEdit = await putAudit(bucket2, yesterday, '1-aaa', [EVENTS[0], EVENTS[1]]);
  const before = await _audit.loadAuditDay(bucket2, yesterday);
  const seal2 = await _audit.sealDayIfClosed(bucket2, yesterday, before, {});
  const doctored = JSON.parse(bucket2.store.get(kEdit));
  doctored.events[0].detail = 'Case 999/2026';
  await bucket2.putObject(kEdit, Buffer.from(JSON.stringify(doctored)));
  const edited = integrity.verify([
    { day: yesterday, blobs: await _audit.loadAuditDay(bucket2, yesterday), seal: seal2 },
  ]);
  check('editing an entry in place is caught end to end',
    !edited.intact && edited.problems.some((p) => p.kind === 'ALTERED_EVENT'));

  // A day with only pre-integrity objects must not be sealed: recording their
  // absence of proof would dress it up as proof.
  const bucket3 = fakeBucket();
  await bucket3.putObject(`${_audit.AUDIT_PREFIX}${yesterday}/old.json`,
    Buffer.from(JSON.stringify({ events: EVENTS })));
  check('a day holding only pre-integrity objects is left unsealed',
    (await _audit.sealDayIfClosed(bucket3, yesterday, await _audit.loadAuditDay(bucket3, yesterday), {})) === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
