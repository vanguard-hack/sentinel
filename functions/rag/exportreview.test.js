// The export review loop. Run: node functions/rag/exportreview.test.js
//
// The loop adds the one thing the approval control was missing — a supervisor
// who can see the document and point at the line — and in doing so it moves the
// two things holding the control up: the document now persists, and the
// approved document can now legitimately CHANGE.
//
// Both are exactly where a review workflow gets quietly broken. So these tests
// attack the loop rather than walk through it: revise after approval, approve
// with objections outstanding, review your own export, substitute someone
// else's document, comment as the agent and then approve as the agent.
const review = require('./exportreview');
const holds = require('./exportholds');
const exportscreen = require('./exportscreen');

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
    async deleteObject(key) { store.delete(key); },
    async listPagedObjects({ prefix }) {
      return {
        contents: [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ keyDetails: { key: k } })),
        truncated: 'false',
      };
    },
  };
}

const OFFICER = { email: 'kumar@ksp.gov.in', name: 'S Kumar' };
const SUPER = { email: 'rao@ksp.gov.in', name: 'A Rao' };

const DOC_V1 = 'Case summary. The victim of the molestation on 12/06 is Lakshmi Devi of Nehru Lane. '
  + 'The accused was arrested on 14/06. A minor victim gave a statement.';
const DOC_V2 = 'Case summary. The victim of the molestation on 12/06 is withheld. '
  + 'The accused was arrested on 14/06. A minor victim gave a statement.';

(async () => {
  const b = fakeBucket();
  const s1 = exportscreen.screen(DOC_V1, { isHtml: false });

  // ── Findings carry positions, which is what makes highlighting possible ──

  check('the screen reports where each concern is, not just that it exists',
    s1.findings.length > 0 && s1.findings.every((f) => Number.isInteger(f.start) && f.end > f.start));
  check('each finding quotes the exact matched text',
    s1.findings.every((f) => DOC_V1.slice(f.start, f.end) === f.quote),
    JSON.stringify(s1.findings.map((f) => [f.start, f.quote])));
  check('each finding carries the sentence a reviewer actually judges',
    s1.findings.every((f) => f.sentence && f.sentence.length > f.quote.length));
  check('findings are ordered as the document reads',
    s1.findings.every((f, i, a) => i === 0 || a[i - 1].start <= f.start));
  check('every occurrence is reported, not only the first',
    exportscreen.screen('a molestation here and a molestation there', { isHtml: false })
      .findings.filter((f) => f.category === 'sexual-offence').length === 2,
    'a name redacted in one paragraph and left in another is the miss this exists to catch');

  // ── A hold, its document, and a thread on a line ────────────────────────

  const hold = await holds.create(b, {
    ...OFFICER, role: 'investigator', kind: 'report-studio', title: 'Charge Sheet — 412/2026',
    reasons: s1.reasons, fingerprint: exportscreen.fingerprint(DOC_V1), stats: s1.stats,
  });
  await review.putContent(b, hold.id, 1, DOC_V1);

  check('the reviewed document is stored so the supervisor can read it',
    (await review.getContent(b, hold.id, 1)) === DOC_V1,
    'a supervisor who cannot read the document is rubber-stamping');
  check('the hold records revision 1', hold.revisions.length === 1 && hold.revisions[0].rev === 1);

  const finding = s1.findings.find((f) => f.category === 'sexual-offence');
  const thread = await review.createThread(b, hold.id, {
    rev: 1, start: finding.sentenceStart, end: finding.sentenceStart + finding.sentence.length,
    quote: finding.sentence, finding,
    author: SUPER.email, authorName: SUPER.name, kind: 'supervisor',
    body: 'Remove the victim name and the lane — together they identify the household.',
  });
  check('a thread anchors to the quoted text, not only to offsets', !!thread.anchor.quote);
  check('a thread from a finding carries the rule that raised it',
    thread.finding && thread.finding.category === 'sexual-offence');

  let threads = await review.listThreads(b, hold.id);
  check('the thread is listed with its comment',
    threads.length === 1 && threads[0].comments.length === 1);
  check('the comment records who is speaking', threads[0].comments[0].kind === 'supervisor');

  // ── The agent may explain; it may not decide ────────────────────────────

  await review.addComment(b, hold.id, thread.id, {
    author: 'agent', authorName: 'Sentinel', kind: 'agent',
    body: 'BNS 72 makes publishing this identity an offence in its own right.',
  });
  threads = await review.listThreads(b, hold.id);
  check('an agent comment is labelled as machine-written',
    threads[0].comments.some((c) => c.kind === 'agent'),
    'a machine explanation must never read as a supervisor instruction');
  check('comments are ordered oldest first',
    threads[0].comments[0].at <= threads[0].comments[1].at);

  // ── Approval is blocked while the objection stands ──────────────────────

  let open = review.openThreads(threads);
  check('the objection counts as open', open.length === 1);

  let blocked = null;
  try {
    await holds.decide(b, hold.id, {
      decision: 'approved', approverEmail: SUPER.email, approverName: SUPER.name,
      openThreads: open.length,
    });
  } catch (e) { blocked = e; }
  check('approval is refused while a comment is unresolved', !!blocked, 'approved with objections outstanding');
  check('  and the officer is told how many', blocked && /1 unresolved comment/.test(blocked.message), blocked && blocked.message);

  // Rejection is deliberately NOT gated — refusing a document while objections
  // stand is coherent, and tidying up first would be absurd.
  const b2 = fakeBucket();
  const h2 = await holds.create(b2, { ...OFFICER, role: 'investigator', kind: 'r', title: 't', reasons: [], fingerprint: 'f', stats: {} });
  let rejectErr = null;
  try {
    await holds.decide(b2, h2.id, { decision: 'rejected', approverEmail: SUPER.email, approverName: SUPER.name, note: 'no', openThreads: 3 });
  } catch (e) { rejectErr = e; }
  check('rejection is not blocked by open comments', !rejectErr, rejectErr && rejectErr.message);

  // ── Send it back, and revise ───────────────────────────────────────────

  await holds.requestChanges(b, hold.id, {
    approverEmail: SUPER.email, approverName: SUPER.name, note: 'See the comment on the first line.',
  });
  const sentBack = await holds.get(b, hold.id);
  check('the hold goes to changes_requested, not rejected', sentBack.status === 'changes_requested',
    'a rejection ends the request; this keeps the conversation');

  let decideErr = null;
  try {
    await holds.decide(b, hold.id, { decision: 'approved', approverEmail: SUPER.email, approverName: SUPER.name, openThreads: 0 });
  } catch (e) { decideErr = e; }
  check('a hold awaiting changes cannot be approved until it is revised', !!decideErr, 'approved without a revision');

  // Only the requesting officer may revise — otherwise the loop becomes a way
  // to substitute a document into someone else's request.
  let wrongHands = null;
  try {
    await holds.addRevision(b, hold.id, { email: SUPER.email, name: SUPER.name, reasons: [], fingerprint: 'x', stats: {} });
  } catch (e) { wrongHands = e; }
  check('another officer cannot revise someone else\'s export', !!wrongHands, 'document substitution');

  const s2 = exportscreen.screen(DOC_V2, { isHtml: false });
  const revised = await holds.addRevision(b, hold.id, {
    ...OFFICER, reasons: s2.reasons, fingerprint: exportscreen.fingerprint(DOC_V2), stats: s2.stats,
  });
  await review.putContent(b, hold.id, 2, DOC_V2);

  check('the revision is recorded as rev 2', revised.revisions.length === 2);
  check('the hold returns to pending for another look', revised.status === 'pending');
  check('the live fingerprint moves to the new revision',
    revised.fingerprint === exportscreen.fingerprint(DOC_V2));
  check('the previous revision is still on the record',
    revised.revisions[0].fingerprint === exportscreen.fingerprint(DOC_V1),
    'the history is the audit trail of what was seen and when');

  // ── Re-anchoring, which is where review tools usually mislead ───────────

  const rethreaded = review.reanchor(await review.listThreads(b, hold.id), DOC_V2);
  check('a thread whose text was edited away is marked outdated',
    rethreaded[0].outdated === true,
    'the alternative is highlighting whatever now sits at those offsets');
  check('an outdated thread stops blocking approval',
    review.openThreads(rethreaded).length === 0,
    'holding approval hostage to a sentence that no longer exists teaches supervisors to resolve without reading');

  // A thread on text that survived must move with it, not stay where it was.
  const surviving = await review.createThread(b, hold.id, {
    rev: 2, start: DOC_V2.indexOf('The accused was arrested on 14/06.'),
    end: DOC_V2.indexOf('The accused was arrested on 14/06.') + 34,
    quote: 'The accused was arrested on 14/06.',
    author: SUPER.email, authorName: SUPER.name, kind: 'supervisor', body: 'Confirm the arrest memo is attached.',
  });
  const shifted = 'PREFIX ADDED AT THE FRONT. ' + DOC_V2;
  const moved = review.reanchor([surviving], shifted).find((t) => t.id === surviving.id);
  check('a thread whose text survived is re-found at its new position',
    !moved.outdated && moved.anchor.start === shifted.indexOf('The accused was arrested on 14/06.'),
    JSON.stringify({ outdated: moved.outdated, start: moved.anchor.start }));
  check('  and the quote is what found it, not the old offset',
    shifted.slice(moved.anchor.start, moved.anchor.end) === moved.anchor.quote);

  // Ambiguity is reported rather than silently guessed at.
  const twice = review.reanchor(
    [{ id: 'x', anchor: { start: 0, end: 5, quote: 'alpha' } }],
    'alpha beta alpha',
  )[0];
  check('a quote appearing twice is flagged as ambiguous', twice.ambiguous === 2);
  check('  and resolves to the occurrence nearest where it was', twice.anchor.start === 0);

  // ── Approve, then try to swap the document ─────────────────────────────

  // Both threads: the one about the victim name, and the arrest-memo question
  // raised at revision 2. The gate does not care which is which — every open
  // question has to be actively closed, which is the point.
  await review.resolveThread(b, hold.id, thread.id, { by: SUPER.email, byName: SUPER.name });
  await review.resolveThread(b, hold.id, surviving.id, { by: SUPER.email, byName: SUPER.name });
  const afterResolve = review.reanchor(await review.listThreads(b, hold.id), DOC_V2);
  await holds.decide(b, hold.id, {
    decision: 'approved', approverEmail: SUPER.email, approverName: SUPER.name,
    openThreads: review.openThreads(afterResolve).length,
  });
  check('with every thread answered, approval goes through',
    (await holds.get(b, hold.id)).status === 'approved');

  const swap = await holds.release(b, hold.id, {
    email: OFFICER.email, fingerprint: exportscreen.fingerprint(DOC_V1),
  });
  check('an approval for revision 2 cannot release revision 1', !swap.ok, swap.reason);
  check('  and says the document changed', /changed since it was approved/.test(swap.reason));

  const good = await holds.release(b, hold.id, {
    email: OFFICER.email, fingerprint: exportscreen.fingerprint(DOC_V2),
  });
  check('the approved revision releases', good.ok, good.reason);
  const twiceUsed = await holds.release(b, hold.id, {
    email: OFFICER.email, fingerprint: exportscreen.fingerprint(DOC_V2),
  });
  check('and an approval is still single-use across the loop', !twiceUsed.ok, twiceUsed.reason);

  // ── The document does not outlive the review ───────────────────────────

  const before = [...b.store.keys()].filter((k) => k.startsWith(review.reviewPrefix(hold.id))).length;
  const deleted = await review.purge(b, hold.id);
  const after = [...b.store.keys()].filter((k) => k.startsWith(review.reviewPrefix(hold.id))).length;
  check('purging removes every stored artefact', before > 0 && deleted === before && after === 0,
    `${before} before, ${deleted} deleted, ${after} after`);
  check('  including the document text itself',
    (await review.getContent(b, hold.id, 2)) === '',
    'a 7-day review window must not become indefinite retention');
  check('  but the hold record survives as the audit trail',
    !!(await holds.get(b, hold.id)),
    'who approved what, and when, outlives the document');

  // ── Both export routes must store the document ─────────────────────────
  //
  // This is the regression that shipped. Sentinel has two export paths —
  // handleReportPdf for anything rendered server-side (Report Studio, the case
  // diary, investigation summaries) and handleExport for what the browser
  // rasterises — and only the second learned to keep the document. A supervisor
  // opening a case diary got "no longer stored" for the exact class of document
  // this feature exists to review, while a dashboard screenshot worked fine.
  //
  // Asserted against the source because the alternative is a live Catalyst
  // request. Thin, but it is the specific thing that broke, and it fails if a
  // third export surface is added later without going through the same door.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');

  check('there is ONE function that opens a hold, not a copy per route',
    (src.match(/async function openExportHold\(/g) || []).length === 1);
  check('  and it is the only place a hold is created',
    (src.match(/exportholds\.create\(/g) || []).length === 1,
    'a second creation site is a second place to forget the document');
  check('  and it is the only place a revision is added',
    (src.match(/exportholds\.addRevision\(/g) || []).length === 1);
  check('  and it stores the reviewed text', /exportreview\.putContent\(bucket, hold\.id, rev/.test(src));

  const callers = (src.match(/await openExportHold\(bucket, \{/g) || []).length;
  check('both export routes go through it', callers === 2, `${callers} caller(s)`);

  const pdfRoute = src.slice(src.indexOf('async function handleReportPdf'), src.indexOf('async function streamToString'));
  check('the server-rendered PDF route opens its hold through the shared door',
    /openExportHold\(bucket, \{/.test(pdfRoute),
    'this is the route the case diary and Report Studio use');
  check('  and drops the stored copy when an approval is redeemed',
    /exportreview\.purge\(bucket, String\(body\.approvalId\)\)/.test(pdfRoute));

  check('storing the document never fails the export',
    /console\.error\('review content write failed \(non-fatal\)/.test(src),
    'a degraded review beats no export at all');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
