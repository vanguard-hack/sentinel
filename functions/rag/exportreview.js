'use strict';

/**
 * Review threads on a held export — the part that lets a supervisor point at a
 * line rather than at a whole document.
 *
 * WHY THE DOCUMENT IS NOW STORED
 *
 * exportholds deliberately did not keep the document, and said so: holding a
 * copy of every flagged report would make a second pile of exactly the material
 * the control exists to protect. That half of the reasoning still stands. The
 * other half — "the supervisor decides on the reasons and the requester, which
 * is what they would act on anyway" — was wrong, and wrong in the specific way
 * this feature is meant to prevent.
 *
 * A supervisor who cannot read the document is not reviewing it. They are
 * approving a title and two matched words, which is rubber-stamping with a
 * signature attached. The answer to the privacy concern is to protect the
 * stored copy — same bucket, same clearance, dropped when the hold is decided
 * or expires — not to blind the only human in the loop.
 *
 * STORAGE SHAPE, AND WHY IT IS FIDDLY
 *
 *   exports/review/<id>/rev-<n>.txt        the reviewed text, one per revision
 *   exports/review/<id>/threads/<tid>.json anchor + resolved state
 *   exports/review/<id>/comments/<cid>.json one object per comment
 *
 * A separate prefix from exports/holds/ on purpose: the hold listing is a
 * prefix scan that parses every object it finds, so review artefacts sharing
 * that prefix would appear in the supervisor's queue as malformed holds.
 *
 * One object per COMMENT, never an array rewritten in place. This codebase has
 * been bitten twice by read-modify-write on a shared blob (a chat silently
 * dropped, then the audit index), and two officers commenting at the same
 * moment is exactly that shape. Thread state is a separate object because
 * resolving is a single-field change where last-write-wins is acceptable — two
 * people resolving the same thread agree about the outcome.
 */

const crypto = require('crypto');

const reviewPrefix = (id) => `exports/review/${id}/`;
const contentKey = (id, rev) => `${reviewPrefix(id)}rev-${rev}.txt`;
const threadKey = (id, tid) => `${reviewPrefix(id)}threads/${tid}.json`;
const commentKey = (id, cid) => `${reviewPrefix(id)}comments/${cid}.json`;

const newId = (p) => `${p}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;

// A quote long enough to be unique but short enough to survive an edit
// elsewhere in the same sentence.
const MAX_QUOTE = 300;
const MAX_BODY = 4000;

async function streamToString(stream) {
  if (!stream) return '';
  if (typeof stream === 'string') return stream;
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(bucket, key) {
  try {
    const raw = await streamToString(await bucket.getObject(key));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function listKeys(bucket, prefix) {
  const keys = [];
  let token;
  do {
    const page = await bucket.listPagedObjects({ prefix, maxKeys: '200', continuationToken: token });
    for (const o of page?.contents || []) {
      const k = o?.keyDetails?.key || o?.key;
      if (k) keys.push(k);
    }
    token = page?.truncated === 'true' || page?.truncated === true ? page?.next_continuation_token : undefined;
  } while (token && keys.length < 2000);
  return keys;
}

// ── Document text ──────────────────────────────────────────────────────────

async function putContent(bucket, id, rev, text) {
  await bucket.putObject(contentKey(id, rev), Buffer.from(String(text || ''), 'utf8'));
}

async function getContent(bucket, id, rev) {
  try {
    return await streamToString(await bucket.getObject(contentKey(id, rev)));
  } catch {
    return '';
  }
}

/**
 * Delete everything held for a review.
 *
 * Called when a hold is consumed or expires. The stored document is the part
 * that matters — leaving it behind would turn a 7-day review window into
 * indefinite retention of the most sensitive reports in the system, which is
 * precisely the objection that kept it out in the first place.
 */
async function purge(bucket, id) {
  const keys = await listKeys(bucket, reviewPrefix(id));
  let deleted = 0;
  for (const k of keys) {
    try { await bucket.deleteObject(k); deleted++; } catch { /* best effort */ }
  }
  return deleted;
}

// ── Threads ────────────────────────────────────────────────────────────────

/**
 * Open a thread against a span of the document.
 *
 * `anchor.quote` is the load-bearing field, not the offsets. Offsets are a
 * convenience for rendering THIS revision; the quote is what lets the thread
 * find itself again after the officer edits the document (see reanchor).
 */
async function createThread(bucket, id, { rev, start, end, quote, author, authorName, body, kind, finding }) {
  const tid = newId('thr');
  const now = Date.now();
  const thread = {
    id: tid,
    holdId: id,
    createdAt: now,
    createdRev: Number(rev) || 1,
    anchor: {
      start: Number(start) || 0,
      end: Number(end) || 0,
      quote: String(quote || '').slice(0, MAX_QUOTE),
    },
    // The rule that produced this, when the thread came from a finding rather
    // than from a supervisor highlighting text by hand.
    finding: finding ? { category: finding.category, label: finding.label, why: finding.why } : null,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    outdated: false,
  };
  await bucket.putObject(threadKey(id, tid), Buffer.from(JSON.stringify(thread)));
  if (body) await addComment(bucket, id, tid, { author, authorName, body, kind });
  return thread;
}

/**
 * `kind` records WHO is speaking: 'officer', 'supervisor' or 'agent'.
 *
 * The agent's comments are labelled because a machine-written explanation must
 * never be mistaken for a supervisor's instruction — the agent explains, a
 * human decides, and the record has to show which is which months later.
 */
async function addComment(bucket, id, threadId, { author, authorName, body, kind }) {
  const cid = newId('cmt');
  const comment = {
    id: cid,
    holdId: id,
    threadId,
    at: Date.now(),
    author: String(author || '').toLowerCase(),
    authorName: String(authorName || ''),
    kind: ['officer', 'supervisor', 'agent'].includes(kind) ? kind : 'officer',
    body: String(body || '').slice(0, MAX_BODY),
  };
  await bucket.putObject(commentKey(id, cid), Buffer.from(JSON.stringify(comment)));
  return comment;
}

async function resolveThread(bucket, id, threadId, { by, byName, resolved = true }) {
  const thread = await readJson(bucket, threadKey(id, threadId));
  if (!thread) throw Object.assign(new Error('No such thread'), { code: 404 });
  const next = {
    ...thread,
    resolved: !!resolved,
    resolvedBy: resolved ? String(by || '').toLowerCase() : null,
    resolvedName: resolved ? String(byName || '') : null,
    resolvedAt: resolved ? Date.now() : null,
  };
  await bucket.putObject(threadKey(id, threadId), Buffer.from(JSON.stringify(next)));
  return next;
}

/** Every thread on a hold, each with its comments in order. */
async function listThreads(bucket, id) {
  const [threadKeys, commentKeys] = await Promise.all([
    listKeys(bucket, `${reviewPrefix(id)}threads/`),
    listKeys(bucket, `${reviewPrefix(id)}comments/`),
  ]);
  const [threads, comments] = await Promise.all([
    Promise.all(threadKeys.map((k) => readJson(bucket, k))),
    Promise.all(commentKeys.map((k) => readJson(bucket, k))),
  ]);
  const byThread = new Map();
  for (const c of comments.filter(Boolean)) {
    if (!byThread.has(c.threadId)) byThread.set(c.threadId, []);
    byThread.get(c.threadId).push(c);
  }
  return threads
    .filter(Boolean)
    .map((t) => ({ ...t, comments: (byThread.get(t.id) || []).sort((a, b) => a.at - b.at) }))
    .sort((a, b) => (a.anchor.start - b.anchor.start) || (a.createdAt - b.createdAt));
}

// ── Re-anchoring ───────────────────────────────────────────────────────────

/**
 * Find each thread again in a revised document.
 *
 * The honest version of a genuinely hard problem. When the officer edits the
 * text, character offsets are worthless — they now point at whatever happens to
 * occupy those positions, which is how a review tool ends up confidently
 * highlighting the wrong sentence.
 *
 * So the quote is searched for instead:
 *   found once      → re-anchored, offsets updated
 *   found several   → the occurrence nearest the old position wins
 *   not found       → marked OUTDATED, exactly as GitHub does
 *
 * No fuzzy matching, deliberately. A thread that says "the text I was about is
 * gone" is useful; one that guesses at the closest surviving sentence is worse
 * than useless, because the supervisor cannot tell that it guessed.
 */
function reanchor(threads, text) {
  const body = String(text || '');
  return (threads || []).map((t) => {
    const quote = t.anchor && t.anchor.quote;
    if (!quote) return { ...t, outdated: true };

    const spans = [];
    let i = body.indexOf(quote);
    while (i !== -1 && spans.length < 20) {
      spans.push(i);
      i = body.indexOf(quote, i + 1);
    }
    if (!spans.length) return { ...t, outdated: true };

    const want = t.anchor.start || 0;
    const start = spans.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best), spans[0]);
    return {
      ...t,
      outdated: false,
      anchor: { ...t.anchor, start, end: start + quote.length },
      ...(spans.length > 1 ? { ambiguous: spans.length } : {}),
    };
  });
}

/**
 * Threads still demanding an answer.
 *
 * An outdated thread does NOT count. Its text is gone, which is the officer
 * having acted on it — holding an approval hostage to a comment about a
 * sentence that no longer exists would teach supervisors to resolve threads
 * without reading them, which is the failure this whole feature exists to
 * avoid.
 */
const openThreads = (threads) => (threads || []).filter((t) => !t.resolved && !t.outdated);

module.exports = {
  putContent, getContent, purge,
  createThread, addComment, resolveThread, listThreads,
  reanchor, openThreads,
  reviewPrefix, contentKey, threadKey, commentKey,
  MAX_QUOTE, MAX_BODY,
};
