'use strict';

/**
 * Held exports — the queue a flagged document waits in, and the record of who
 * released it.
 *
 * STORAGE SHAPE
 *
 * One Stratus object per hold, at exports/holds/<id>.json. Not one index blob
 * holding every hold: that shape is a read-modify-write, and this codebase has
 * already been bitten by it twice (the assistant's conversation blob, where two
 * saves silently dropped a chat, and the audit index). Two officers hitting
 * Export at the same moment must not be able to erase each other's request —
 * so nothing here ever rewrites a shared object. Creates are independent
 * writes, and listing is a prefix scan.
 *
 * The one place a write-write race survives is two supervisors deciding the
 * same hold in the same instant. decide() re-reads immediately before writing
 * and refuses a hold that is already decided, which narrows that to the few
 * milliseconds between the read and the write. Stratus has no compare-and-set
 * to close it entirely; the residue is that one of two simultaneous decisions
 * wins, both supervisors saw the same pending item, and the decision that
 * landed is the one recorded and audited. That is a far smaller problem than a
 * lost queue, and it is stated here rather than left to be discovered.
 *
 * WHY A HOLD CARRIES A CONTENT HASH
 *
 * An approval authorises ONE document. Without the hash the control has a hole
 * wide enough to drive through: request approval for a bland report, wait for
 * a supervisor to approve it, then submit anything at all with that approval
 * id. release() requires the fingerprint to match what was screened, so a
 * swapped document is refused even by the officer who legitimately holds the
 * approval.
 *
 * WHY APPROVALS ARE SINGLE-USE
 *
 * A reusable approval turns into a standing permission that outlives the
 * reason it was granted. Once released, the hold is marked consumed and cannot
 * release again — a second export of the same document needs a second decision.
 */

const crypto = require('crypto');

const HOLD_PREFIX = 'exports/holds/';
const holdKey = (id) => `${HOLD_PREFIX}${id}.json`;

// A pending request nobody acted on stops being actionable. Expiring it beats
// leaving a stale queue that supervisors learn to ignore, and beats an
// approval that could be redeemed months later against a changed case.
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// An approval that is granted and never used should not stay redeemable
// indefinitely either.
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const newHoldId = () =>
  `exp_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;

async function streamToString(stream) {
  if (!stream) return '';
  if (typeof stream === 'string') return stream;
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function readHold(bucket, id) {
  try {
    const raw = await streamToString(await bucket.getObject(holdKey(id)));
    const rec = raw ? JSON.parse(raw) : null;
    return rec && rec.id === id ? rec : null;
  } catch {
    return null;
  }
}

async function writeHold(bucket, rec) {
  await bucket.putObject(holdKey(rec.id), Buffer.from(JSON.stringify(rec)));
  return rec;
}

/** When this hold last moved — a new revision restarts the review clock. */
const lastActivity = (rec) => Math.max(
  rec.requestedAt || 0,
  rec.changesRequestedAt || 0,
  ...(rec.revisions || []).map((r) => r.at || 0),
);

/** Effective status, applying expiry at read time rather than by a sweeper. */
function effectiveStatus(rec, now = Date.now()) {
  if (!rec) return 'missing';
  // A review in progress expires from the last thing that happened to it, not
  // from when it was first raised — otherwise a document under active
  // discussion dies mid-conversation on day seven.
  if (rec.status === 'changes_requested') {
    return now - (rec.changesRequestedAt || rec.requestedAt) > PENDING_TTL_MS ? 'expired' : 'changes_requested';
  }
  if (rec.status === 'pending' && now - lastActivity(rec) > PENDING_TTL_MS) return 'expired';
  if (rec.status === 'approved' && !rec.consumedAt && now - rec.decidedAt > APPROVAL_TTL_MS) {
    return 'expired';
  }
  return rec.status;
}

/**
 * Record a new held export.
 *
 * `reasons` and `fingerprint` come from exportscreen; `title` and `kind` are
 * what the supervisor sees in the queue. The document itself is NOT stored —
 * holding a copy of every flagged report would create a second, less protected
 * pile of exactly the sensitive material this feature exists to control. The
 * supervisor decides on the reasons and the requester, which is what they would
 * act on anyway.
 */
async function create(bucket, { email, name, role, kind, title, reasons, fingerprint, stats }) {
  const rec = {
    id: newHoldId(),
    status: 'pending',
    requestedAt: Date.now(),
    requestedBy: String(email || '').toLowerCase(),
    requestedName: String(name || ''),
    requestedRole: String(role || ''),
    kind: String(kind || 'report'),
    title: String(title || 'Untitled export').slice(0, 160),
    reasons: (reasons || []).map((r) => ({
      category: r.category, label: r.label, why: r.why, evidence: String(r.evidence || '').slice(0, 120),
    })),
    stats: stats || {},
    fingerprint: String(fingerprint || ''),
    // Revision history. `fingerprint` above always mirrors the LATEST
    // revision, so every existing caller keeps working; the array is what makes
    // "approve, then swap the document" impossible across a review loop.
    revisions: [{
      rev: 1,
      at: Date.now(),
      by: String(email || '').toLowerCase(),
      byName: String(name || ''),
      fingerprint: String(fingerprint || ''),
      reasons: (reasons || []).map((r) => ({ category: r.category, label: r.label })),
      stats: stats || {},
    }],
    changesRequestedAt: null,
    changesRequestedBy: null,
    changesRequestedName: null,
    decidedAt: null,
    decidedBy: null,
    decidedName: null,
    decision: null,
    note: '',
    consumedAt: null,
  };
  return writeHold(bucket, rec);
}

async function get(bucket, id) {
  if (!/^exp_[a-z0-9_]+$/i.test(String(id || ''))) return null;
  const rec = await readHold(bucket, id);
  return rec ? { ...rec, status: effectiveStatus(rec) } : null;
}

/**
 * The supervisor's queue. Pending first and oldest-first within that, because
 * the thing waiting longest is the thing blocking an officer.
 */
async function list(bucket, { status = 'pending', limit = 100 } = {}) {
  const keys = [];
  let token;
  do {
    const page = await bucket.listPagedObjects({
      prefix: HOLD_PREFIX,
      maxKeys: '200',
      continuationToken: token,
    });
    // listPagedObjects wraps each entry in a StratusObject — the key sits on
    // .keyDetails, not on the instance itself.
    for (const o of page?.contents || []) {
      const k = o?.keyDetails?.key || o?.key;
      if (k) keys.push(k);
    }
    token =
      page?.truncated === 'true' || page?.truncated === true
        ? page?.next_continuation_token
        : undefined;
  } while (token && keys.length < 2000);

  const recs = await Promise.all(
    keys.map(async (k) => {
      try {
        const raw = await streamToString(await bucket.getObject(k));
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }),
  );

  const now = Date.now();
  const out = recs
    .filter(Boolean)
    .map((r) => ({ ...r, status: effectiveStatus(r, now) }))
    .filter((r) => (status === 'all' ? true : r.status === status));

  out.sort((a, b) =>
    a.status === b.status
      ? a.status === 'pending' ? a.requestedAt - b.requestedAt : b.requestedAt - a.requestedAt
      : a.status === 'pending' ? -1 : 1,
  );
  return out.slice(0, Math.max(1, Math.min(500, limit)));
}

/**
 * Approve or reject.
 *
 * The approver's identity comes from THEIR OWN session, never from the request
 * payload — the caller cannot name who approved. That is the difference between
 * real dual control and the shape of it: a UI that collects a second officer's
 * badge and password client-side, then discards them, proves nothing and
 * manufactures false confidence.
 *
 * A supervisor cannot release their own request. Two-person integrity means two
 * people; without this check a supervisor exporting a flagged document would be
 * a single-party decision wearing a queue.
 */
async function decide(bucket, id, { decision, approverEmail, approverName, note, openThreads = 0 }) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw Object.assign(new Error('decision must be approved or rejected'), { code: 400 });
  }
  const rec = await readHold(bucket, id);
  if (!rec) throw Object.assign(new Error('No such export request'), { code: 404 });

  const status = effectiveStatus(rec);
  if (status === 'expired') {
    throw Object.assign(new Error('This request has expired; the officer must export again'), { code: 409 });
  }
  if (status === 'changes_requested') {
    throw Object.assign(
      new Error('Changes were requested — the officer must submit a revision before this can be decided'),
      { code: 409 },
    );
  }
  if (status !== 'pending') {
    throw Object.assign(
      new Error(`Already ${rec.decision} by ${rec.decidedName || rec.decidedBy}`),
      { code: 409 },
    );
  }

  const approver = String(approverEmail || '').toLowerCase();
  if (!approver) throw Object.assign(new Error('approver identity missing'), { code: 401 });
  if (approver === rec.requestedBy) {
    throw Object.assign(
      new Error('You cannot approve your own export — a second officer must review it'),
      { code: 403 },
    );
  }

  // An approval closes the review, so it cannot be granted while the reviewer's
  // own questions are still open. The supervisor is never deadlocked — they can
  // resolve any thread themselves once satisfied — but a concern has to be
  // actively closed rather than quietly outrun by the Approve button.
  //
  // Rejection is deliberately NOT gated: refusing a document while objections
  // stand is coherent, and needing to tidy up before saying no would be absurd.
  if (decision === 'approved' && Number(openThreads) > 0) {
    throw Object.assign(
      new Error(
        `${openThreads} unresolved ${openThreads === 1 ? 'comment' : 'comments'} — `
        + 'resolve or answer them before approving',
      ),
      { code: 409 },
    );
  }

  return writeHold(bucket, {
    ...rec,
    status: decision,
    decision,
    decidedAt: Date.now(),
    decidedBy: approver,
    decidedName: String(approverName || ''),
    note: String(note || '').slice(0, 500),
  });
}

/**
 * Redeem an approval for one export.
 *
 * Every guard here answers a specific way the control could be walked around:
 * a rejected hold, someone else's approval, an approval for a different
 * document, or a second use of one that already released.
 */

/**
 * Send the document back to the officer with the review still attached.
 *
 * Distinct from `rejected`, and the distinction is the whole point of the loop:
 * a rejection ends the request, while this keeps the same hold, the same
 * threads and the same history, and waits for a revision. The officer sees
 * what has to change, fixes it, and resubmits into the conversation that was
 * already happening rather than starting a fresh one a supervisor has to read
 * from scratch.
 */
async function requestChanges(bucket, id, { approverEmail, approverName, note }) {
  const rec = await readHold(bucket, id);
  if (!rec) throw Object.assign(new Error('No such export request'), { code: 404 });

  const status = effectiveStatus(rec);
  if (status === 'expired') {
    throw Object.assign(new Error('This request has expired; the officer must export again'), { code: 409 });
  }
  if (status !== 'pending') {
    throw Object.assign(new Error(`This request is already ${status}`), { code: 409 });
  }
  const approver = String(approverEmail || '').toLowerCase();
  if (!approver) throw Object.assign(new Error('approver identity missing'), { code: 401 });
  if (approver === rec.requestedBy) {
    throw Object.assign(
      new Error('You cannot review your own export — a second officer must look at it'),
      { code: 403 },
    );
  }

  return writeHold(bucket, {
    ...rec,
    status: 'changes_requested',
    changesRequestedAt: Date.now(),
    changesRequestedBy: approver,
    changesRequestedName: String(approverName || ''),
    note: String(note || '').slice(0, 500),
  });
}

/**
 * The officer submits a corrected document.
 *
 * THIS is where the fingerprint binding earns its keep. Each revision carries
 * its own hash and `fingerprint` moves to the newest, so an approval granted on
 * revision 3 cannot release revision 1 — the check in release() is unchanged
 * and now simply has a moving target that only ever moves forward.
 *
 * Only the officer who raised the request may revise it. Otherwise the review
 * loop would be a way for anyone to substitute a document into someone else's
 * approved request, which is the exact hole the hash was added to close.
 */
async function addRevision(bucket, id, { email, name, reasons, fingerprint, stats }) {
  const rec = await readHold(bucket, id);
  if (!rec) throw Object.assign(new Error('No such export request'), { code: 404 });

  const status = effectiveStatus(rec);
  if (status === 'expired') {
    throw Object.assign(new Error('This request has expired; export again to start a new review'), { code: 409 });
  }
  if (!['pending', 'changes_requested'].includes(status)) {
    throw Object.assign(new Error(`This request is ${status} and cannot be revised`), { code: 409 });
  }
  if (rec.requestedBy !== String(email || '').toLowerCase()) {
    throw Object.assign(new Error('Only the officer who requested this export can revise it'), { code: 403 });
  }

  const rev = (rec.revisions || []).length + 1;
  return writeHold(bucket, {
    ...rec,
    status: 'pending',
    fingerprint: String(fingerprint || ''),
    reasons: (reasons || []).map((r) => ({
      category: r.category, label: r.label, why: r.why, evidence: String(r.evidence || '').slice(0, 120),
    })),
    stats: stats || {},
    revisions: [...(rec.revisions || []), {
      rev,
      at: Date.now(),
      by: String(email || '').toLowerCase(),
      byName: String(name || ''),
      fingerprint: String(fingerprint || ''),
      reasons: (reasons || []).map((r) => ({ category: r.category, label: r.label })),
      stats: stats || {},
    }],
    // A new revision reopens the question, so any previous decision is void.
    changesRequestedAt: null,
    changesRequestedBy: null,
    changesRequestedName: null,
    decidedAt: null,
    decidedBy: null,
    decidedName: null,
    decision: null,
  });
}

/** The revision under review — the one a supervisor is looking at. */
const latestRevision = (rec) => ((rec && rec.revisions) || []).length || 1;

async function release(bucket, id, { email, fingerprint }) {
  const rec = await readHold(bucket, id);
  if (!rec) return { ok: false, reason: 'No such approval' };

  const status = effectiveStatus(rec);
  if (status === 'expired') return { ok: false, reason: 'This approval has expired' };
  if (status === 'pending') return { ok: false, reason: 'Still awaiting supervisor approval' };
  if (status === 'rejected') {
    return { ok: false, reason: rec.note ? `Rejected: ${rec.note}` : 'This export was rejected' };
  }
  if (rec.consumedAt) return { ok: false, reason: 'This approval has already been used' };
  if (rec.requestedBy !== String(email || '').toLowerCase()) {
    return { ok: false, reason: 'This approval belongs to another officer' };
  }
  if (rec.fingerprint !== fingerprint) {
    return { ok: false, reason: 'The document has changed since it was approved — request approval again' };
  }

  await writeHold(bucket, { ...rec, consumedAt: Date.now() });
  return { ok: true, hold: rec };
}

module.exports = {
  create, get, list, decide, release, effectiveStatus,
  requestChanges, addRevision, latestRevision,
  HOLD_PREFIX, PENDING_TTL_MS, APPROVAL_TTL_MS,
};
