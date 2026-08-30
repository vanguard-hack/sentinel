'use strict';

/**
 * Officer memory for the assistant.
 *
 * Three stores, because the assistant needs three different things and no one
 * store does all three well:
 *
 *   Catalyst Cache   short-term working memory — the live conversation buffer,
 *                    read and written on every single turn, so it has to be
 *                    cheap. Does not need to survive the day.
 *   Catalyst NoSQL   durable memory — a TTL'd copy of every turn (safety net
 *                    and the input to consolidation), plus a small set of
 *                    precise long-term facts keyed by the officer.
 *   QuickML KB       semantic memory — "what did we say about FIR 4029 last
 *                    week" is a meaning search, not a key lookup. Reuses the
 *                    knowledge base the RAG lane already talks to rather than
 *                    standing up a vector store.
 *
 * Everything here is best-effort. None of these resources can be created from
 * code (Cache segments and NoSQL tables are console-only), so every read
 * returns empty and every write returns false when the backing store is
 * absent — the assistant then behaves exactly as it did before memory existed.
 *
 * Console setup required once:
 *   Cache segment  chat-sessions
 *   NoSQL table    chat_session_turns          PK session_id (S)  SK turn_timestamp (N)  TTL expires_at
 *   NoSQL table    officer_long_term_memory    PK badge_id (S)    SK memory_key (S)      TTL expires_at
 *   NoSQL table    memory_kb_documents         PK badge_id (S)    SK kb_document_id (S)
 */

const { NoSQLItem, NoSQLMarshall, NoSQLUnMarshall, NoSQLEnum } = require('zcatalyst-sdk-node/lib/no-sql');

const { NoSQLOperator } = NoSQLEnum;

const CACHE_SEGMENT = process.env.MEMORY_CACHE_SEGMENT || 'chat-sessions';
const TURNS_TABLE = process.env.MEMORY_TURNS_TABLE || 'chat_session_turns';
const FACTS_TABLE = process.env.MEMORY_FACTS_TABLE || 'officer_long_term_memory';
const KBDOCS_TABLE = process.env.MEMORY_KB_TABLE || 'memory_kb_documents';

// Sliding idle window for the live buffer. Catalyst Cache expiry is expressed
// in WHOLE HOURS, so the TTL itself cannot express "45 minutes" — the cache
// entry is given an hour and the finer window is enforced here against
// last_seen. An officer who comes back after the window gets a fresh session
// rather than a silently resurrected one.
const IDLE_MINUTES = Number(process.env.MEMORY_IDLE_MINUTES) || 45;
const IDLE_MS = IDLE_MINUTES * 60_000;
const CACHE_TTL_HOURS = Math.max(1, Number(process.env.MEMORY_CACHE_TTL_HOURS) || 1);

// The buffer is working memory, not history. Full history lives in
// chat_session_turns; keeping the blob small is what makes the cache fast.
const MAX_BUFFER_TURNS = Number(process.env.MEMORY_BUFFER_TURNS) || 20;
const TURN_TTL_DAYS = Number(process.env.MEMORY_TURN_TTL_DAYS) || 7;
const MAX_FACTS = 40;
const CONSOLIDATE_AFTER_TURNS = Number(process.env.MEMORY_CONSOLIDATE_AFTER) || 12;

const KEY = {
  session: (id) => `session#${id}`,
  summary: (id) => `summary#${id}`,
};

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const now = () => Date.now();

// ── Catalyst Cache ─────────────────────────────────────────────────────────
//
// cache.segment(name) does NOT resolve a segment by name: the SDK parseInt()s
// whatever it is given and, on NaN, silently falls back to the project's
// DEFAULT segment — so a name would appear to work while writing somewhere
// else entirely. The id has to be looked up once and reused.
let segmentId; // undefined = never looked up, null = segment absent
let segmentProbedAt = 0;
const SEGMENT_REPROBE_MS = 5 * 60_000;

async function segmentFor(app) {
  if (segmentId === null && now() - segmentProbedAt < SEGMENT_REPROBE_MS) return null;
  if (segmentId) return app.cache().segment(segmentId);
  try {
    const all = await app.cache().getAllSegment();
    const hit = (all || []).find((s) => s.segmentName === CACHE_SEGMENT);
    segmentId = hit ? hit.id : null;
    segmentProbedAt = now();
    return hit ? app.cache().segment(hit.id) : null;
  } catch {
    // No cache configured for the project at all.
    segmentId = null;
    segmentProbedAt = now();
    return null;
  }
}

/**
 * The live conversation buffer.
 *
 * Returns `{ turns, scratchpad, resumed }`. `resumed` is false when there was
 * nothing to read or the session had gone idle past the window — the caller
 * should then treat this as a new conversation rather than stitching it onto
 * whatever was there before.
 */
async function readBuffer(app, sessionId, badgeId) {
  const empty = { turns: [], scratchpad: {}, resumed: false };
  if (!sessionId) return empty;
  const seg = await segmentFor(app);
  if (!seg) return empty;
  let raw;
  try {
    raw = await seg.getValue(sessionId);
  } catch {
    return empty; // key expired or never existed
  }
  if (!raw) return empty;
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return empty;
  }
  // Per-officer isolation is not a policy layer bolted on top — a buffer whose
  // owner does not match the caller is simply not that caller's memory.
  if (state.badge_id && badgeId && state.badge_id !== badgeId) return empty;
  if (!state.last_seen || now() - state.last_seen > IDLE_MS) return empty;
  return {
    turns: Array.isArray(state.turns) ? state.turns : [],
    scratchpad: state.agent_scratchpad && typeof state.agent_scratchpad === 'object'
      ? state.agent_scratchpad
      : {},
    resumed: true,
  };
}

async function writeBuffer(app, sessionId, badgeId, { turns, scratchpad }) {
  if (!sessionId) return false;
  const seg = await segmentFor(app);
  if (!seg) return false;
  const state = {
    badge_id: badgeId || null,
    last_seen: now(),
    turns: (turns || []).slice(-MAX_BUFFER_TURNS),
    agent_scratchpad: scratchpad || {},
  };
  const value = JSON.stringify(state);
  // Cache values are strings only, and the entry is rewritten every turn —
  // which is also what resets the sliding TTL.
  try {
    await seg.update(sessionId, value, CACHE_TTL_HOURS);
    return true;
  } catch {
    try {
      await seg.put(sessionId, value, CACHE_TTL_HOURS);
      return true;
    } catch {
      return false;
    }
  }
}

async function dropBuffer(app, sessionId) {
  const seg = await segmentFor(app);
  if (!seg || !sessionId) return false;
  try {
    await seg.delete(sessionId);
    return true;
  } catch {
    return false;
  }
}

// ── Catalyst NoSQL ─────────────────────────────────────────────────────────

const native = (data) => {
  const item = data && data.item;
  if (!item) return null;
  try {
    return NoSQLUnMarshall.makeMap(typeof item.toJSON === 'function' ? item.toJSON() : item);
  } catch {
    return null;
  }
};

const rowsOf = (resp) => {
  const list = (resp && (resp.get || resp.getResponseData())) || [];
  return list.map(native).filter(Boolean);
};

// A table that has not been created in the console fails on every call. Once
// that is known, stop paying the round-trip on every turn — but re-probe, so
// creating the table starts working without a redeploy.
const tableMissingAt = new Map();
const TABLE_REPROBE_MS = 5 * 60_000;
const tableMissing = (name) => now() - (tableMissingAt.get(name) || 0) < TABLE_REPROBE_MS;

async function queryPartition(app, tableName, attribute, value, { limit = 100, forward = true } = {}) {
  if (tableMissing(tableName)) return [];
  try {
    const resp = await app.nosql().table(tableName).queryTable({
      key_condition: {
        attribute,
        operator: NoSQLOperator.EQUALS,
        value: NoSQLMarshall.makeString(value),
      },
      forward_scan: forward,
      limit,
    });
    tableMissingAt.delete(tableName);
    return rowsOf(resp);
  } catch {
    // Table not created yet, or NoSQL not enabled — memory degrades to none.
    tableMissingAt.set(tableName, now());
    return [];
  }
}

/**
 * Durable per-turn log. Written after the answer, alongside the cache
 * write-back: if the cache evicts early this is what consolidation reads.
 *
 * `expires_at` is epoch MILLIseconds, matching turn_timestamp. If the platform
 * reads the TTL attribute as seconds the rows simply outlive their window and
 * get swept by the retention path below — the opposite mistake (seconds read
 * as millis) would delete every turn the moment it was written.
 */
async function appendTurns(app, sessionId, badgeId, turns) {
  if (!sessionId || !turns || !turns.length) return false;
  const base = now();
  const items = turns.slice(0, 8).map((t, i) => ({
    item: NoSQLItem.from({
      session_id: sessionId,
      // Distinct sort keys: a user turn and its answer are written together
      // and would otherwise collide on the same millisecond.
      turn_timestamp: base + i,
      badge_id: badgeId || 'unknown',
      role: clip(t.role, 20),
      text: clip(t.text, 4000),
      created_at: base,
      expires_at: base + TURN_TTL_DAYS * 86_400_000,
    }),
  }));
  if (tableMissing(TURNS_TABLE)) return false;
  try {
    await app.nosql().table(TURNS_TABLE).insertItems(...items);
    return true;
  } catch {
    tableMissingAt.set(TURNS_TABLE, now());
    return false;
  }
}

async function sessionTurns(app, sessionId, limit = 60) {
  return queryPartition(app, TURNS_TABLE, 'session_id', sessionId, { limit });
}

/** Long-term structured facts for one officer. */
async function readFacts(app, badgeId, { limit = MAX_FACTS } = {}) {
  if (!badgeId) return [];
  const rows = await queryPartition(app, FACTS_TABLE, 'badge_id', badgeId, { limit: 200 });
  const live = rows.filter((r) => !r.expires_at || Number(r.expires_at) > now());
  return live
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
    .slice(0, limit);
}

async function writeFacts(app, badgeId, facts) {
  if (!badgeId || !facts || !facts.length) return 0;
  const ts = now();
  const items = facts.slice(0, MAX_FACTS).map((f) => {
    const row = {
      badge_id: badgeId,
      memory_key: clip(f.memory_key, 200),
      value: clip(f.value, 2000),
      kind: clip(f.kind || 'fact', 30),
      updated_at: ts,
    };
    // TTL is per item, and only for facts that genuinely perish ("working the
    // night shift this week"). A stated preference has no expiry.
    if (f.ttl_days) row.expires_at = ts + Number(f.ttl_days) * 86_400_000;
    if (f.session_id) row.source_session = clip(f.session_id, 80);
    return { item: NoSQLItem.from(row) };
  });
  if (tableMissing(FACTS_TABLE)) return 0;
  try {
    await app.nosql().table(FACTS_TABLE).insertItems(...items);
    return items.length;
  } catch {
    tableMissingAt.set(FACTS_TABLE, now());
    return 0;
  }
}

async function deleteFactKeys(app, badgeId, keys) {
  if (!badgeId || !keys.length) return 0;
  try {
    await app.nosql().table(FACTS_TABLE).deleteItems(
      ...keys.map((k) => ({ keys: NoSQLItem.from({ badge_id: badgeId, memory_key: k }) }))
    );
    return keys.length;
  } catch {
    return 0;
  }
}

/**
 * Session pointer. Turns are partitioned by session_id, so without this the
 * officer's own sessions are unenumerable — which would make both
 * consolidation and "delete my memory" impossible to carry out.
 */
async function noteSession(app, badgeId, sessionId, patch = {}) {
  if (!badgeId || !sessionId) return false;
  return (await writeFacts(app, badgeId, [{
    memory_key: KEY.session(sessionId),
    kind: 'session',
    value: JSON.stringify({ session_id: sessionId, ...patch }),
    session_id: sessionId,
  }])) > 0;
}

const sessionsOf = (facts) =>
  facts
    .filter((f) => String(f.memory_key || '').startsWith('session#'))
    .map((f) => {
      try {
        return JSON.parse(f.value);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

// ── QuickML knowledge base (semantic recall) ───────────────────────────────

async function kbDocuments(app, badgeId) {
  if (!badgeId) return [];
  const rows = await queryPartition(app, KBDOCS_TABLE, 'badge_id', badgeId, { limit: 50 });
  return rows.map((r) => String(r.kb_document_id)).filter(Boolean);
}

async function noteKbDocument(app, badgeId, documentId, sessionId) {
  if (!badgeId || !documentId) return false;
  try {
    await app.nosql().table(KBDOCS_TABLE).insertItems({
      item: NoSQLItem.from({
        badge_id: badgeId,
        kb_document_id: String(documentId),
        session_id: clip(sessionId, 80),
        created_at: now(),
        // The policy expiry, deliberately NOT a TTL attribute: a KB document
        // has to be deleted through an explicit API call, so nothing would
        // actually remove it if the pointer row quietly expired first.
        retention_expires_at: now() + 365 * 86_400_000,
      }),
    });
    return true;
  } catch {
    return false;
  }
}

// A recall question asks about the past rather than about the records. Only
// these reach the knowledge base — memory retrieval is a tool, not something
// that runs on every turn.
const RECALL_RE = /\b(remember|recall|earlier|previously|last (?:time|week|month|session)|we (?:discussed|talked|spoke)|you (?:said|told me|mentioned)|i (?:asked|said|told you)|the other day|before that|my (?:usual|preference|preferences))\b/i;
const wantsRecall = (q) => RECALL_RE.test(String(q || ''));

const STOP = new Set(('the a an and or of in on at to for with what which who when where how is are was were did do does about ' +
  'me my i we our you your it this that these those from by tell show give please').split(' '));

const tokens = (s) =>
  String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));

/**
 * Semantic recall over the officer's own past conversations.
 *
 * Prefers the QuickML knowledge base, scoped to the documents that belong to
 * THIS officer — an unscoped search would read every officer's memory, which
 * is the one thing this feature must never do. With no KB document yet (or no
 * RAG lane available) it ranks the consolidated summaries already in NoSQL, so
 * recall works from the first consolidation rather than only after a KB push.
 */
async function recall(app, badgeId, query, { ragSearch, facts } = {}) {
  if (!badgeId) return null;
  const docs = await kbDocuments(app, badgeId);
  if (docs.length && typeof ragSearch === 'function') {
    try {
      const text = await ragSearch(query, docs);
      if (text && text.trim()) return { text: text.trim(), origin: 'quickml', documents: docs };
    } catch {
      // fall through to the local ranking
    }
  }
  const summaries = (facts || (await readFacts(app, badgeId, { limit: 200 })))
    .filter((f) => String(f.memory_key || '').startsWith('summary#'));
  if (!summaries.length) return null;
  const qt = tokens(query);
  if (!qt.length) return null;
  const scored = summaries
    .map((s) => {
      const st = new Set(tokens(s.value));
      const overlap = qt.filter((t) => st.has(t)).length;
      return { s, score: overlap / qt.length };
    })
    .filter((x) => x.score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (!scored.length) return null;
  return {
    text: scored.map((x) => `- ${x.s.value}`).join('\n'),
    origin: 'nosql-summaries',
    documents: [],
  };
}

// ── Assembled context ──────────────────────────────────────────────────────

/**
 * What the orchestrator hands the router: the short-term buffer as verbatim
 * turns, the long-term facts as a compact block, and recall only when the
 * question actually asked for it.
 */
function assemble({ buffer, facts, recalled }) {
  const history = (buffer && buffer.turns ? buffer.turns : [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.text)
    .slice(-8)
    .map((t) => ({ role: t.role, content: clip(t.text, 1500) }));

  const lines = (facts || [])
    .filter((f) => !String(f.memory_key || '').startsWith('session#'))
    .filter((f) => !String(f.memory_key || '').startsWith('summary#'))
    .slice(0, 12)
    .map((f) => `- ${String(f.memory_key).replace(/^[a-z]+#/, '')}: ${f.value}`);

  const blocks = [];
  if (lines.length) blocks.push('What you already know about this officer:\n' + lines.join('\n'));
  if (recalled && recalled.text) blocks.push('From their earlier conversations:\n' + recalled.text);

  return { history, longTerm: blocks.join('\n\n').slice(0, 3000) };
}

// ── Consolidation ──────────────────────────────────────────────────────────

const CONSOLIDATE_PROMPT = `You maintain an assistant's memory of one police officer.
From the conversation transcript, produce JSON only:
{"summary":"2-3 sentences on what was discussed, naming any FIR/case/person/place referenced","facts":[{"memory_key":"pref#<name>|entity#<name>|case#<id>","value":"<short fact>","ttl_days":<number or null>}]}
Rules: at most 5 facts. Record only durable, useful things — stated preferences,
entities the officer keeps returning to, cases they are working. Never record a
one-off question as a fact. Set ttl_days only for something that genuinely
expires (a shift, a temporary posting); otherwise null. No prose outside JSON.`;

function parseConsolidation(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1));
    if (!o || typeof o.summary !== 'string') return null;
    return {
      summary: o.summary.trim().slice(0, 1200),
      facts: (Array.isArray(o.facts) ? o.facts : [])
        .filter((f) => f && typeof f.memory_key === 'string' && typeof f.value === 'string')
        .filter((f) => /^(pref|entity|case)#/.test(f.memory_key))
        .slice(0, 5),
    };
  } catch {
    return null;
  }
}

/**
 * Turn a session's raw turns into durable memory: one summary plus a handful
 * of structured facts. Triggered on session end / buffer growth rather than by
 * a nightly scan — turns are partitioned by session, so there is no way to
 * enumerate "everything unconsolidated" without a session pointer anyway.
 *
 * `summarize` is injected so this module holds no LLM dependency of its own.
 * `pushKb` is optional; without it memory stays structured-only and recall
 * falls back to ranking the summaries in NoSQL.
 */
async function consolidate(app, { sessionId, badgeId, summarize, pushKb }) {
  if (!sessionId || !badgeId || typeof summarize !== 'function') return null;
  const facts = await readFacts(app, badgeId, { limit: 200 });
  const pointer = sessionsOf(facts).find((s) => s.session_id === sessionId) || {};
  const since = Number(pointer.consolidated_through || 0);

  const turns = (await sessionTurns(app, sessionId)).filter((t) => Number(t.turn_timestamp) > since);
  if (turns.length < 2) return null;

  const transcript = turns
    .sort((a, b) => Number(a.turn_timestamp) - Number(b.turn_timestamp))
    .map((t) => `${t.role}: ${clip(t.text, 800)}`)
    .join('\n')
    .slice(0, 12_000);

  const parsed = parseConsolidation(await summarize(CONSOLIDATE_PROMPT, transcript));
  if (!parsed) return null;

  const through = Math.max(...turns.map((t) => Number(t.turn_timestamp) || 0));
  const written = await writeFacts(app, badgeId, [
    { memory_key: KEY.summary(sessionId), kind: 'summary', value: parsed.summary, session_id: sessionId },
    ...parsed.facts.map((f) => ({
      memory_key: f.memory_key,
      kind: f.memory_key.split('#')[0],
      value: f.value,
      ttl_days: f.ttl_days || 0,
      session_id: sessionId,
    })),
  ]);
  await noteSession(app, badgeId, sessionId, { consolidated_through: through, consolidated_at: now() });

  let kbDocument = null;
  if (typeof pushKb === 'function') {
    try {
      kbDocument = await pushKb({ badgeId, sessionId, summary: parsed.summary, transcript });
      if (kbDocument) await noteKbDocument(app, badgeId, kbDocument, sessionId);
    } catch {
      // Structured memory is already durable; the KB push is an upgrade.
    }
  }
  return { summary: parsed.summary, facts: written, kb_document_id: kbDocument, through };
}

// ── Retention ──────────────────────────────────────────────────────────────

/**
 * "Delete my memory", and the sealed-case path.
 *
 * `match` narrows the wipe to memory mentioning one case; without it every
 * memory the officer has is removed. KB documents are deleted through the
 * caller's `dropKb` because they do not expire on their own — the pointer
 * table exists precisely so that this can reach them.
 */
async function forget(app, badgeId, { match, dropKb } = {}) {
  if (!badgeId) return null;
  const facts = await readFacts(app, badgeId, { limit: 500 });
  const re = match ? new RegExp(String(match).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  const hit = (f) => !re || re.test(String(f.memory_key)) || re.test(String(f.value));

  const sessions = sessionsOf(facts.filter(hit));
  const keys = facts.filter(hit).map((f) => String(f.memory_key));
  const removedFacts = await deleteFactKeys(app, badgeId, keys);

  let removedTurns = 0;
  for (const s of sessions) {
    await dropBuffer(app, s.session_id);
    const turns = await sessionTurns(app, s.session_id, 200);
    try {
      await app.nosql().table(TURNS_TABLE).deleteItems(
        ...turns.map((t) => ({
          keys: NoSQLItem.from({ session_id: s.session_id, turn_timestamp: Number(t.turn_timestamp) }),
        }))
      );
      removedTurns += turns.length;
    } catch {
      // Turns carry a 7-day TTL of their own; a failure here delays, not defeats.
    }
  }

  const docs = await kbDocuments(app, badgeId);
  let removedDocs = 0;
  for (const id of docs) {
    if (re && !re.test(id) && !sessions.length && match) continue;
    let gone = true;
    if (typeof dropKb === 'function') gone = await dropKb(id).catch(() => false);
    if (!gone) continue;
    try {
      await app.nosql().table(KBDOCS_TABLE).deleteItems({
        keys: NoSQLItem.from({ badge_id: badgeId, kb_document_id: id }),
      });
      removedDocs += 1;
    } catch {
      // Leave the pointer in place: an orphaned pointer is recoverable, a
      // deleted pointer to a live KB document is not.
    }
  }
  return { facts: removedFacts, turns: removedTurns, kb_documents: removedDocs, sessions: sessions.length };
}

module.exports = {
  CACHE_SEGMENT,
  TURNS_TABLE,
  FACTS_TABLE,
  KBDOCS_TABLE,
  IDLE_MINUTES,
  CONSOLIDATE_AFTER_TURNS,
  readBuffer,
  writeBuffer,
  dropBuffer,
  appendTurns,
  sessionTurns,
  readFacts,
  writeFacts,
  noteSession,
  sessionsOf,
  kbDocuments,
  noteKbDocument,
  wantsRecall,
  recall,
  assemble,
  consolidate,
  parseConsolidation,
  forget,
};
