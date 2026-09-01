'use strict';

/**
 * Sending a diary or a report to a named officer.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * It is worth being exact, because the obvious reading is wrong. Sentinel does
 * not scope case diaries or reports by owner — handleInvestigation and
 * handleReportDocs admit any investigator, supervisor or admin to any record.
 * So sharing here does NOT grant access to something the recipient could not
 * already open.
 *
 * What it does is direct attention: it puts a specific document in a specific
 * officer's inbox, with a note saying why and a record of who sent it. That is
 * the actual workflow in a station — "Rao has sent you the diary on 412/2026,
 * look at the seizure memo" — and it is worth building. But the UI says
 * "shared with", never "granted access to", and this comment exists so nobody
 * later mistakes this module for an authorisation boundary and starts relying
 * on it as one. If per-case ownership is ever introduced, THAT is where access
 * gets decided, and this module will need to be revisited alongside it.
 *
 * STORAGE
 *
 *   shares/to/<recipient>/<id>.json     what has been sent to me
 *   shares/by-doc/<kind>/<docId>/<id>.json   who this document went to
 *
 * The same record written twice, deliberately. Stratus lists by prefix only,
 * and the two questions this feature has to answer — "what is in my inbox" and
 * "who has seen this" — cannot both be prefix scans of one layout. Two
 * independent creates beat one index object that two simultaneous shares would
 * race each other to rewrite, which is a bug this codebase has already shipped
 * twice.
 */

const crypto = require('crypto');

const TO_PREFIX = 'shares/to/';
const DOC_PREFIX = 'shares/by-doc/';

const KINDS = new Set(['diary', 'report']);
const MAX_RECIPIENTS = 20;
const MAX_NOTE = 1000;

const newShareId = () => `shr_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;

// Email addresses become path segments, so anything that could climb out of the
// prefix is removed rather than escaped. A local-part with a slash is not a
// real address; a share silently landing in another officer's inbox is a real
// problem.
//
// The hyphen is escaped deliberately. Written as [^a-z0-9._%+-@] the `+-@` is
// a RANGE — 0x2B to 0x40 — which quietly admits `/`, `.` and `:`, so
// "../../admin@ksp.gov.in" sanitised to itself and wrote outside its prefix.
// The test caught it; the class now lists the hyphen last where it cannot form
// a range, and leading dots are collapsed as well, because a segment of "…"
// needs no slash to be unwelcome.
const emailKey = (email) => String(email || '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9._%+@-]/g, '_')
  .replace(/\.{2,}/g, '_');

const toKey = (email, id) => `${TO_PREFIX}${emailKey(email)}/${id}.json`;
const docKey = (kind, docId, id) => `${DOC_PREFIX}${kind}/${String(docId).replace(/[^A-Za-z0-9_-]/g, '_')}/${id}.json`;

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

/**
 * Send one document to one or more officers.
 *
 * Returns what actually happened per recipient rather than a bare count: an
 * officer told "shared with 4 people" when one address was a typo has been
 * misinformed about who is now expecting to read it.
 */
async function create(bucket, { kind, docId, title, from, fromName, recipients, note }) {
  if (!KINDS.has(String(kind))) {
    throw Object.assign(new Error('kind must be diary or report'), { code: 400 });
  }
  const id = String(docId || '').trim();
  if (!id) throw Object.assign(new Error('docId is required'), { code: 400 });

  const sender = String(from || '').toLowerCase().trim();
  if (!sender) throw Object.assign(new Error('sender identity missing'), { code: 401 });

  const list = [...new Set(
    (Array.isArray(recipients) ? recipients : [])
      .map((r) => String(r || '').toLowerCase().trim())
      .filter(Boolean),
  )];
  if (!list.length) throw Object.assign(new Error('choose at least one officer'), { code: 400 });
  if (list.length > MAX_RECIPIENTS) {
    throw Object.assign(new Error(`at most ${MAX_RECIPIENTS} officers at a time`), { code: 400 });
  }

  const at = Date.now();
  const sent = [];
  const skipped = [];

  for (const to of list) {
    // Sending to yourself is a no-op, not an error — it usually means a
    // multi-select where the sender was in the list, and failing the whole
    // share over it would lose the other recipients.
    if (to === sender) { skipped.push({ email: to, why: 'that is you' }); continue; }

    const rec = {
      id: newShareId(),
      kind: String(kind),
      docId: id,
      title: String(title || '').slice(0, 200),
      from: sender,
      fromName: String(fromName || ''),
      to,
      note: String(note || '').slice(0, MAX_NOTE),
      at,
      readAt: null,
      revokedAt: null,
    };
    // Recipient copy first: if the second write fails the share still reaches
    // the person it was for, and the sender's "who has this" view is merely
    // incomplete. The reverse would show the sender a delivery that never
    // arrived.
    await bucket.putObject(toKey(to, rec.id), Buffer.from(JSON.stringify(rec)));
    try {
      await bucket.putObject(docKey(rec.kind, rec.docId, rec.id), Buffer.from(JSON.stringify(rec)));
    } catch {
      // Non-fatal, and deliberately silent to the sender: the document reached
      // the officer, which is what they asked for.
    }
    sent.push(rec);
  }

  return { sent, skipped };
}

const live = (r) => r && !r.revokedAt;

/** Everything sent to this officer, newest first. */
async function inbox(bucket, email, { includeRevoked = false } = {}) {
  const keys = await listKeys(bucket, `${TO_PREFIX}${emailKey(email)}/`);
  const recs = (await Promise.all(keys.map((k) => readJson(bucket, k)))).filter(Boolean);
  return recs
    .filter((r) => includeRevoked || live(r))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** Who a document has been sent to. */
async function forDoc(bucket, kind, docId) {
  const keys = await listKeys(bucket, `${DOC_PREFIX}${kind}/${String(docId).replace(/[^A-Za-z0-9_-]/g, '_')}/`);
  const recs = (await Promise.all(keys.map((k) => readJson(bucket, k)))).filter(Boolean);
  return recs.filter(live).sort((a, b) => (b.at || 0) - (a.at || 0));
}

const unreadCount = (list) => (list || []).filter((r) => live(r) && !r.readAt).length;

/**
 * Mark one share read. Only the recipient can — a sender marking their own
 * share read would make the unread badge a fiction.
 */
async function markRead(bucket, email, shareId) {
  const key = toKey(email, shareId);
  const rec = await readJson(bucket, key);
  if (!rec || rec.to !== String(email || '').toLowerCase().trim()) {
    throw Object.assign(new Error('No such share'), { code: 404 });
  }
  if (rec.readAt) return rec;
  const next = { ...rec, readAt: Date.now() };
  await bucket.putObject(key, Buffer.from(JSON.stringify(next)));
  // Best effort on the sender's copy: the recipient's own view is the one that
  // has to be right.
  try { await bucket.putObject(docKey(rec.kind, rec.docId, rec.id), Buffer.from(JSON.stringify(next))); } catch { /* ignore */ }
  return next;
}

/**
 * Withdraw a share. Only the sender may, and it is marked rather than deleted —
 * "Rao sent me this and then withdrew it" is exactly the kind of thing an audit
 * trail exists to still know.
 */
async function revoke(bucket, senderEmail, shareId, recipient) {
  const key = toKey(recipient, shareId);
  const rec = await readJson(bucket, key);
  if (!rec) throw Object.assign(new Error('No such share'), { code: 404 });
  if (rec.from !== String(senderEmail || '').toLowerCase().trim()) {
    throw Object.assign(new Error('Only the officer who shared this can withdraw it'), { code: 403 });
  }
  const next = { ...rec, revokedAt: Date.now() };
  await bucket.putObject(key, Buffer.from(JSON.stringify(next)));
  try { await bucket.putObject(docKey(rec.kind, rec.docId, rec.id), Buffer.from(JSON.stringify(next))); } catch { /* ignore */ }
  return next;
}

module.exports = {
  create, inbox, forDoc, markRead, revoke, unreadCount,
  KINDS, MAX_RECIPIENTS, MAX_NOTE, TO_PREFIX, DOC_PREFIX, emailKey,
};
