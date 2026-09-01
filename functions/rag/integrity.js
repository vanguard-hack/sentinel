'use strict';

/**
 * Tamper-evidence for the audit trail.
 *
 * THE HOLE THIS CLOSES
 *
 * The trail records who read which case, from where, on what device. It is the
 * artefact an inquiry reaches for. But it was ordinary JSON in Stratus: anyone
 * who could write those objects could also edit them, and nothing anywhere
 * would show that they had. A trail that can be quietly corrected is not
 * evidence of anything — and the dangerous part is not the missing line, it is
 * that what remains still looks complete. "Nobody accessed that case" and "the
 * line saying who did was removed" read identically.
 *
 * WHY NOT A PLAIN HASH CHAIN
 *
 * The obvious answer is the one used for a chain of custody: every row carries
 * the hash of the row before it. That works there because custody is naturally
 * serial — one officer hands an item to the next.
 *
 * This log is not serial. Every officer's every action appends concurrently,
 * from separate function invocations, into separate Stratus objects precisely
 * so that writes never contend. Stratus has no compare-and-swap, so two
 * requests reading the same head hash would both write against it and fork the
 * chain. The fork would then be indistinguishable from tampering, and a
 * detector that fires on ordinary Tuesday traffic is one officers learn to
 * ignore — which costs more than having none.
 *
 * SO: THREE LEVELS, EACH MATCHED TO WHAT IT CAN ACTUALLY PROVE
 *
 *   1. BLOB HASH — every audit object stores a hash of the events inside it.
 *      Needs no coordination at all: the writer hashes what it is writing.
 *      Detects: an event's contents edited in place.
 *
 *   2. DAY SEAL — once a day is over its object set is closed and can be
 *      enumerated with no race at all. The seal lists every object in that day
 *      with its hash.
 *      Detects: a whole object deleted, or one backdated into a past day.
 *
 *   3. SEAL CHAIN — each seal carries the hash of the seal written before it,
 *      in the order they were written (NOT calendar order, so sealing an older
 *      day later still links correctly).
 *      Detects: a seal itself deleted or rewritten to cover the deletion.
 *
 * Sealing is the only step that coordinates, and it runs at most once per day
 * per day — from an admin opening the audit page — rather than on every write.
 *
 * WHAT THIS IS NOT
 *
 * It is not tamper-PROOF. Someone with full Stratus access could delete an
 * event, rewrite its blob hash, rewrite the day seal, and rewrite every seal
 * after it. Making that impossible needs a store this platform does not have.
 * What it makes impossible is *silent* alteration — the quiet edit of one line
 * by someone who then walks away. That is the realistic threat and this is the
 * achievable defence.
 *
 * It is also not retrospective: entries written before this module existed
 * carry no hash. They are reported as UNVERIFIABLE, never as intact and never
 * as altered, because claiming either would be a lie about what we can check.
 *
 * THE ONE THING AN ADMIN SHOULD DO
 *
 * Copy the head hash somewhere outside Catalyst — a notebook is enough. The
 * chain proves internal consistency; a head hash recorded elsewhere is what
 * turns that into proof against someone who can rewrite the whole store.
 */

const { createHash } = require('crypto');

const ALG = 'sha256';
/** Bumped only if canonicalisation changes; old blobs keep verifying at their own version. */
const VERSION = 1;
/** The first seal in the chain has no predecessor. */
const GENESIS = '0'.repeat(64);

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Deterministic JSON with keys sorted at every level.
 *
 * JSON.stringify follows key INSERTION order, which is a property of how an
 * object happened to be built rather than of what it contains. Two objects
 * holding identical data would hash differently if assembled in a different
 * order — so a later refactor of the writer, changing nothing an officer would
 * notice, would invalidate every hash already stored. Sorting removes that.
 *
 * `undefined` and a missing key both become nothing; null stays null. An
 * absent field and an explicitly-null one must not collide, so null is
 * written and undefined is dropped, exactly as JSON.stringify does.
 */
function stableStringify(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  return JSON.stringify(value === undefined ? null : value);
}

/** Hash of the events in one audit object. The `integrity` field is never itself hashed. */
function hashEvents(events) {
  return sha256(stableStringify(Array.isArray(events) ? events : []));
}

/** The integrity block to store alongside the events. */
function sealBlob(events) {
  return { v: VERSION, alg: ALG, events: hashEvents(events), count: (events || []).length };
}

/**
 * Check one audit object against its own recorded hash.
 *
 * Three outcomes, deliberately distinct. `unverifiable` is not a soft "fail" —
 * it is the correct answer for an object written before hashing existed, and
 * conflating it with either intact or altered is how a verifier starts lying.
 */
function verifyBlob(key, blob) {
  const events = (blob && Array.isArray(blob.events) && blob.events) || [];
  const stored = blob && blob.integrity;
  if (!stored || !stored.events) {
    return { key, status: 'unverifiable', count: events.length, hash: null };
  }
  const actual = hashEvents(events);
  return {
    key,
    status: actual === stored.events ? 'intact' : 'altered',
    count: events.length,
    hash: actual,
    expected: stored.events,
  };
}

// ── Day seals ───────────────────────────────────────────────────────────────

/**
 * Build a seal over one closed day.
 *
 * `blobs` is every audit object for that day, each already hashed. Sorted by
 * key so the seal is a function of the day's contents and nothing else — two
 * verifiers listing the objects in different orders must produce the same seal.
 *
 * `prevSealHash` chains this seal to the one written before it. Sealing older
 * days out of order is normal (an admin opens last month's log today), so the
 * chain follows WRITE order, which is total, rather than calendar order, which
 * would be full of gaps.
 */
function buildSeal({ day, blobs, prevSealHash, prevDay, seq, sealedAt }) {
  const entries = [...blobs]
    .map((b) => ({ key: String(b.key), hash: String(b.hash || ''), count: Number(b.count) || 0 }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const body = {
    v: VERSION,
    alg: ALG,
    day,
    seq,
    sealedAt,
    prevDay: prevDay || null,
    prevSealHash: prevSealHash || GENESIS,
    blobCount: entries.length,
    eventCount: entries.reduce((n, e) => n + e.count, 0),
    blobs: entries,
  };
  // The seal's own hash covers the link to its predecessor, so rewriting a
  // seal to point at a different one changes its hash and breaks the seal
  // after it.
  return { ...body, sealHash: sha256(`${body.prevSealHash}\n${stableStringify(body)}`) };
}

/** Recompute a stored seal's hash. False means the seal document itself was edited. */
function sealHashValid(seal) {
  if (!seal || !seal.sealHash) return false;
  const { sealHash, ...body } = seal;
  return sha256(`${body.prevSealHash || GENESIS}\n${stableStringify(body)}`) === sealHash;
}

const PROBLEM_TEXT = {
  ALTERED_EVENT: 'the entries in this file no longer match the fingerprint written with them — one was edited after the fact',
  DELETED_FILE: 'a file of entries recorded in the day seal is no longer present — entries have been removed',
  BACKDATED_FILE: 'a file of entries exists that was not present when the day was sealed — entries were added to a closed day',
  ALTERED_FILE: 'a file of entries no longer matches the fingerprint recorded in the day seal',
  ALTERED_SEAL: 'the day seal itself has been rewritten',
  BROKEN_SEAL_LINK: 'this day seal does not follow the one written before it — a seal has been removed or replaced',
};

/**
 * Verify a set of days.
 *
 * `days` is `[{ day, blobs: [{ key, blob }], seal }]`, already loaded. Keeping
 * the I/O out means the rules can be tested directly against constructed
 * tampering, which is the only way to know a detector detects anything.
 *
 * Seal-chain checking is deliberately confined to the seals handed in: a range
 * of one day cannot see its predecessor, so a missing link there would be a
 * false alarm about a day nobody asked about. `chain` is checked only where
 * both ends of a link are present.
 */
function verify(days, { knownSeals = null } = {}) {
  const problems = [];
  const perDay = [];
  let verified = 0;
  let unverifiable = 0;

  for (const entry of days) {
    const day = entry.day;
    const seal = entry.seal || null;
    const results = (entry.blobs || []).map((b) => verifyBlob(b.key, b.blob));

    for (const r of results) {
      if (r.status === 'intact') verified += r.count;
      else if (r.status === 'unverifiable') unverifiable += r.count;
      else problems.push({ kind: 'ALTERED_EVENT', day, key: r.key, detail: PROBLEM_TEXT.ALTERED_EVENT });
    }

    let sealStatus = 'unsealed';
    if (seal) {
      sealStatus = 'sealed';
      if (!sealHashValid(seal)) {
        sealStatus = 'altered';
        problems.push({ kind: 'ALTERED_SEAL', day, key: null, detail: PROBLEM_TEXT.ALTERED_SEAL });
      }

      const present = new Map(results.map((r) => [r.key, r]));
      const sealed = new Map((seal.blobs || []).map((b) => [b.key, b]));

      for (const [key, rec] of sealed) {
        const now = present.get(key);
        if (!now) {
          problems.push({ kind: 'DELETED_FILE', day, key, detail: PROBLEM_TEXT.DELETED_FILE });
        } else if (now.hash && now.hash !== rec.hash) {
          // Distinct from ALTERED_EVENT: that says the file disagrees with
          // itself, this says it disagrees with the sealed record of it. An
          // edit that also rewrote the file's own hash trips only this one.
          problems.push({ kind: 'ALTERED_FILE', day, key, detail: PROBLEM_TEXT.ALTERED_FILE });
        }
      }
      for (const key of present.keys()) {
        if (!sealed.has(key)) {
          problems.push({ kind: 'BACKDATED_FILE', day, key, detail: PROBLEM_TEXT.BACKDATED_FILE });
        }
      }
    }

    perDay.push({
      day,
      sealStatus,
      files: results.length,
      events: results.reduce((n, r) => n + r.count, 0),
      sealHash: seal ? seal.sealHash : null,
    });
  }

  // The seal-to-seal links, over whichever seals the caller could see.
  const chain = (knownSeals || days.map((d) => d.seal).filter(Boolean))
    .slice()
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1];
    const cur = chain[i];
    // Only a CONSECUTIVE pair proves anything. A gap in seq means the seal
    // between them was simply not loaded, which is not evidence of removal.
    if ((cur.seq || 0) - (prev.seq || 0) !== 1) continue;
    if (cur.prevSealHash !== prev.sealHash) {
      problems.push({
        kind: 'BROKEN_SEAL_LINK', day: cur.day, key: null, detail: PROBLEM_TEXT.BROKEN_SEAL_LINK,
      });
    }
  }

  return {
    intact: problems.length === 0,
    problems,
    days: perDay,
    eventsVerified: verified,
    eventsUnverifiable: unverifiable,
    headHash: chain.length ? chain[chain.length - 1].sealHash : null,
  };
}

/**
 * One sentence for the admin, because a verdict nobody reads protects nothing.
 *
 * States what was checked as well as what was found: "intact" over four
 * entries none of which could be verified would otherwise read as a clean bill
 * of health for the whole log.
 */
function summarise(v) {
  if (v.problems.length) {
    const kinds = [...new Set(v.problems.map((p) => p.kind))].map((k) => PROBLEM_TEXT[k]).join('; ');
    return `Integrity check FAILED on ${v.problems.length} item${v.problems.length === 1 ? '' : 's'}: ${kinds}.`;
  }
  const parts = [];
  if (v.eventsVerified) parts.push(`${v.eventsVerified} entries verified against their fingerprints`);
  if (v.eventsUnverifiable) {
    parts.push(`${v.eventsUnverifiable} written before tamper-evidence was added and cannot be checked`);
  }
  const sealed = v.days.filter((d) => d.sealStatus === 'sealed').length;
  const open = v.days.filter((d) => d.sealStatus === 'unsealed').length;
  if (sealed) parts.push(`${sealed} day${sealed === 1 ? '' : 's'} sealed`);
  if (open) parts.push(`${open} day${open === 1 ? '' : 's'} still open`);
  return parts.length ? `${parts.join(', ')}.` : 'No audit entries in this range.';
}

module.exports = {
  ALG, VERSION, GENESIS, PROBLEM_TEXT,
  stableStringify, hashEvents, sealBlob, verifyBlob,
  buildSeal, sealHashValid, verify, summarise,
};
