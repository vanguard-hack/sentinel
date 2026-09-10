# Answer Confidence Score + Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every factual assistant answer a deterministic 0–100 confidence score, and let an officer flag a wrong answer so the correction is remembered and taken into account for every future officer asking a similar question.

**Architecture:** A new pure `computeConfidence()` in `index.js` scores an answer from signals the pipeline already produces (answering lane, `grounding.js`'s check, citation count) plus one new signal (a matching past correction). A new `functions/rag/feedback.js` module, backed by a new Data Store table (`AssistantFeedback`, created the same way `ChatConversations` was), stores corrections and finds a matching one via the same token-overlap technique `memory.js` already uses for its own recall — extracted from `memory.js` so both modules share one implementation. The match is injected into `history` the same way `memory.js`'s long-term context already is, so every lane that already spreads `...history` picks it up for free. Two frontend pieces: a confidence chip and a bug-icon feedback dialog, both added to the existing per-message actions row.

**Tech Stack:** Node.js (CommonJS) backend, plain `check(name, cond)` test scripts (no framework) run via `node functions/rag/<file>.test.js`; React (JS) frontend, Jest tests under `react-app/src/__smoke__/`.

**Spec:** `docs/superpowers/specs/2026-09-10-confidence-and-feedback-design.md`

## Global Constraints

- No LLM self-reported confidence — `computeConfidence` is a pure function over already-known signals, never a model call.
- Feedback is shared across every officer, not per-officer scoped — no `badgeId`/session gate on the lookup or the match.
- Matching is token-overlap only (same `>= 0.2` threshold `memory.js` already uses) — no semantic/QuickML search in this plan.
- Every new store access (`feedback.js`) is best-effort and fails open: a missing table or a thrown error must never change the assistant's existing behavior or surface a 500 to the officer.
- A matched correction reaches the model's context but is never shown to the officer in the UI.
- `ReportedBy` on every feedback row is resolved server-side from the session — never trusted from the request body.

---

### Task 1: `computeConfidence` — pure confidence scoring

**Files:**
- Modify: `functions/rag/index.js` — add `computeConfidence` and its constants immediately after `sanitizeForDisplay` (currently ends at line 1160, right before `function readBody(req) {`).
- Test: `functions/rag/confidence.test.js` (new)

**Interfaces:**
- Produces: `function computeConfidence({ source, groundingResult, citedSources, feedbackMatch })` → `number | null`. `groundingResult` is `null` or `{ checked: boolean, grounded: boolean, ... }` (shape already produced by `grounding.check`, see `functions/rag/grounding.js`). `citedSources` is an array (possibly empty). `feedbackMatch` is `null` or a truthy object — only its truthiness matters here.

- [ ] **Step 1: Write the failing test**

Create `functions/rag/confidence.test.js`:

```js
// Answer confidence scoring. Run: node functions/rag/confidence.test.js
let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
const fnSrc = src.slice(src.indexOf('const CONFIDENCE_BASELINES'), src.indexOf('function readBody('));
// eslint-disable-next-line no-new-func
const { computeConfidence } = new Function(`${fnSrc}\nreturn { computeConfidence };`)();

const GROUNDED = { checked: true, grounded: true };
const UNGROUNDED = { checked: true, grounded: false };
const NOT_CHECKED = { checked: false, grounded: true };

check('a Data Store answer, grounded and cited, gets the zcql baseline',
  computeConfidence({ source: 'zcql', groundingResult: GROUNDED, citedSources: [{}], feedbackMatch: null }) === 85);

check('a knowledge-base answer gets the rag baseline',
  computeConfidence({ source: 'rag', groundingResult: GROUNDED, citedSources: [{}], feedbackMatch: null }) === 70);

check('a general-knowledge fallback gets a low baseline even with no citations',
  computeConfidence({ source: 'fallback', groundingResult: null, citedSources: [], feedbackMatch: null }) === 40);

check('an ungrounded answer is penalised',
  computeConfidence({ source: 'zcql', groundingResult: UNGROUNDED, citedSources: [{}], feedbackMatch: null }) === 55);

check('a grounding result that was never checked is not penalised',
  computeConfidence({ source: 'zcql', groundingResult: NOT_CHECKED, citedSources: [{}], feedbackMatch: null }) === 85);

check('no grounding result at all is not penalised',
  computeConfidence({ source: 'zcql', groundingResult: null, citedSources: [{}], feedbackMatch: null }) === 85);

check('a lane that normally cites but has zero citations is penalised',
  computeConfidence({ source: 'tools', groundingResult: GROUNDED, citedSources: [], feedbackMatch: null }) === 60);

check('fallback is not double-penalised for having no citations (already priced into its baseline)',
  computeConfidence({ source: 'fallback', groundingResult: null, citedSources: [], feedbackMatch: null }) === 40);

check('a matching past correction is penalised',
  computeConfidence({ source: 'rag', groundingResult: GROUNDED, citedSources: [{}], feedbackMatch: { note: 'x' } }) === 45);

check('penalties stack and clamp at the floor rather than going negative',
  computeConfidence({ source: 'rag', groundingResult: UNGROUNDED, citedSources: [], feedbackMatch: { note: 'x' } }) === 5);

check('an attachment/vision answer gets the same baseline as a matched scanned record',
  computeConfidence({ source: 'attachment', groundingResult: GROUNDED, citedSources: [{}], feedbackMatch: null }) === 75
  && computeConfidence({ source: 'vision', groundingResult: GROUNDED, citedSources: [{}], feedbackMatch: null }) === 75
  && computeConfidence({ source: 'digitised-records', groundingResult: GROUNDED, citedSources: [{}], feedbackMatch: null }) === 75);

check('chat is not a factual claim, so it gets no score',
  computeConfidence({ source: 'chat', groundingResult: null, citedSources: [], feedbackMatch: null }) === null);

check('guide is not a factual claim either',
  computeConfidence({ source: 'guide', groundingResult: null, citedSources: [], feedbackMatch: null }) === null);

check('an unrecognised source fails closed to no score rather than a guessed baseline',
  computeConfidence({ source: 'something-new', groundingResult: null, citedSources: [], feedbackMatch: null }) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions/rag && node confidence.test.js`
Expected: crashes with `TypeError: Cannot read properties of undefined` or similar, because `src.indexOf('const CONFIDENCE_BASELINES')` returns `-1` — `computeConfidence` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

In `functions/rag/index.js`, find this exact block (the end of `sanitizeForDisplay`):

```js
function sanitizeForDisplay(text, components) {
  let t = stripStrayCodeBlocks(text);
  ({ text: t, components } = stripMarkdownTables(t, components));
  components = promoteDistrictCharts(components);
  t = stripDuplicatedLists(t, components);
  return { text: t, components };
}

function readBody(req) {
```

Replace it with:

```js
function sanitizeForDisplay(text, components) {
  let t = stripStrayCodeBlocks(text);
  ({ text: t, components } = stripMarkdownTables(t, components));
  components = promoteDistrictCharts(components);
  t = stripDuplicatedLists(t, components);
  return { text: t, components };
}

// How much to trust a lane's answer by default, before any penalty. Every
// value `source` can actually take must be listed here — a lane missing
// from this map gets no score at all rather than a guessed baseline, which
// is deliberate: computeConfidence fails closed on an unrecognised lane.
const CONFIDENCE_BASELINES = {
  zcql: 85,
  'digitised-records': 75,
  attachment: 75,
  vision: 75,
  tools: 75,
  rag: 70,
  fallback: 40,
};
// Lanes where a citation is the normal shape of a correct answer, so citing
// nothing is itself a signal — NOT `fallback`, whose baseline already prices
// in that it never cites anything by construction.
const CITES_EXPECTED = new Set(['zcql', 'tools', 'rag', 'digitised-records', 'attachment', 'vision']);

// Deterministic, computed from signals the pipeline already produces —
// never a model self-report. Returns null for a lane with no baseline
// (chat, guide, command, guardrail, anything not listed above): none of
// those are factual claims with a truth value, so a percentage on them
// would be meaningless. Otherwise a number in [5, 98] — never certainty
// either way.
function computeConfidence({ source, groundingResult, citedSources, feedbackMatch }) {
  const baseline = CONFIDENCE_BASELINES[source];
  if (baseline === undefined) return null;
  let score = baseline;
  if (groundingResult && groundingResult.checked && !groundingResult.grounded) score -= 30;
  if (CITES_EXPECTED.has(source) && !(citedSources && citedSources.length)) score -= 15;
  if (feedbackMatch) score -= 25;
  return Math.max(5, Math.min(98, score));
}

function readBody(req) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions/rag && node confidence.test.js`
Expected: `14 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add functions/rag/index.js functions/rag/confidence.test.js
git commit -m "feat(assistant): add computeConfidence, a deterministic answer confidence score"
```

---

### Task 2: Extract shared token-overlap matching in `memory.js`

**Files:**
- Modify: `functions/rag/memory.js:357-412` (the `RECALL_RE`/`wantsRecall`/`STOP`/`tokens`/`recall` region)
- Modify: `functions/rag/memory.test.js` (add tests for the newly-exported pure functions)

**Interfaces:**
- Produces: `tokens(s: string) => string[]` (already exists, now exported), `overlapScore(queryTokens: string[], candidateText: string) => number` (new), `OVERLAP_THRESHOLD` (new, `0.2`) — all exported from `memory.js` for `feedback.js` (Task 3) to reuse.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `functions/rag/memory.test.js`, after the existing `wantsRecall` checks (after the line `check('a place name containing "before" is not a recall question', ...)`):

```js
// ── Shared token-overlap matching (also used by feedback.js) ───────────────
check('overlapScore is exported', typeof m.overlapScore === 'function');
check('OVERLAP_THRESHOLD is exported and matches the value recall() has always used',
  m.OVERLAP_THRESHOLD === 0.2);
check('identical text scores a perfect overlap',
  m.overlapScore(m.tokens('how many FIRs in Belagavi'), 'how many FIRs in Belagavi') === 1);
check('a completely unrelated candidate scores zero',
  m.overlapScore(m.tokens('how many FIRs in Belagavi'), 'weather forecast for Mysuru') === 0);
check('a partial match scores between zero and one',
  m.overlapScore(m.tokens('how many FIRs in Belagavi last month'), 'FIRs in Belagavi') > 0
  && m.overlapScore(m.tokens('how many FIRs in Belagavi last month'), 'FIRs in Belagavi') < 1);
check('empty query tokens score zero rather than throwing',
  m.overlapScore([], 'anything at all') === 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions/rag && node memory.test.js`
Expected: `FAIL overlapScore is exported` (and the checks after it fail too, since `m.overlapScore` is `undefined`).

- [ ] **Step 3: Write minimal implementation**

In `functions/rag/memory.js`, find:

```js
const STOP = new Set(('the a an and or of in on at to for with what which who when where how is are was were did do does about ' +
  'me my i we our you your it this that these those from by tell show give please').split(' '));

const tokens = (s) =>
  String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
```

Add directly below it:

```js
// How much of the query's own vocabulary shows up in a candidate text —
// shared with feedback.js, which asks the identical question ("is this
// stored item about the same thing as this query") over a different
// candidate shape than the conversation summaries below.
function overlapScore(queryTokens, candidateText) {
  if (!queryTokens.length) return 0;
  const ct = new Set(tokens(candidateText));
  return queryTokens.filter((t) => ct.has(t)).length / queryTokens.length;
}

// The minimum overlap ratio for "the same thing," used by both recall()
// below and feedback.js's findSimilar — one constant, not two copies that
// could drift apart.
const OVERLAP_THRESHOLD = 0.2;
```

Then find, inside `recall()`:

```js
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
```

Replace it with:

```js
  const qt = tokens(query);
  if (!qt.length) return null;
  const scored = summaries
    .map((s) => ({ s, score: overlapScore(qt, s.value) }))
    .filter((x) => x.score >= OVERLAP_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
```

Finally, in `module.exports` at the bottom of the file, add `tokens`, `overlapScore`, and `OVERLAP_THRESHOLD`:

```js
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
  tokens,
  overlapScore,
  OVERLAP_THRESHOLD,
  recall,
  assemble,
  consolidate,
  parseConsolidation,
  forget,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions/rag && node memory.test.js`
Expected: all checks pass (previous count plus the 5 new ones), `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add functions/rag/memory.js functions/rag/memory.test.js
git commit -m "refactor(memory): extract overlapScore/OVERLAP_THRESHOLD for feedback.js to share"
```

---

### Task 3: `functions/rag/feedback.js` — storage and matching

**Files:**
- Create: `functions/rag/feedback.js`
- Test: `functions/rag/feedback.test.js` (new)

**Interfaces:**
- Consumes: `memory.tokens`, `memory.overlapScore`, `memory.OVERLAP_THRESHOLD` (Task 2).
- Produces: `async function submitFeedback(app, { question, answer, note, reportedBy, convId }) => boolean`; `async function findSimilar(app, question) => { note: string, question: string } | null`; `FEEDBACK_TABLE` (string constant, env-overridable).

- [ ] **Step 1: Write the failing test**

Create `functions/rag/feedback.test.js`:

```js
// Shared corrective feedback. Run: node functions/rag/feedback.test.js
const feedback = require('./feedback');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

// ── submitFeedback ───────────────────────────────────────────────────────
const captured = [];
const writeApp = {
  datastore: () => ({
    table: () => ({
      insertRow: async (row) => { captured.push(row); },
    }),
  }),
};

(async () => {
  const ok = await feedback.submitFeedback(writeApp, {
    question: 'how many FIRs in Belagavi last month',
    answer: 'There were 42 FIRs.',
    note: 'The real count is 51 — this excluded two police stations.',
    reportedBy: 'psi.rao@ksp.gov.in',
    convId: 'conv-1',
  });
  check('submitFeedback reports success', ok === true);
  check('exactly one row was inserted', captured.length === 1);
  check('the row carries the question, note and reporter',
    captured[0].Question === 'how many FIRs in Belagavi last month'
    && captured[0].Note === 'The real count is 51 — this excluded two police stations.'
    && captured[0].ReportedBy === 'psi.rao@ksp.gov.in');
  check('a FeedbackId and CreatedAt are generated, not left blank',
    typeof captured[0].FeedbackId === 'string' && captured[0].FeedbackId.length > 0
    && Number.isFinite(captured[0].CreatedAt));

  check('a blank note is refused before any write is attempted',
    (await feedback.submitFeedback(writeApp, {
      question: 'x', answer: 'y', note: '  ', reportedBy: 'a', convId: 'c',
    })) === false && captured.length === 1);

  check('a blank question is refused the same way',
    (await feedback.submitFeedback(writeApp, {
      question: '', answer: 'y', note: 'z', reportedBy: 'a', convId: 'c',
    })) === false && captured.length === 1);

  // ── submitFeedback: the store is absent ──────────────────────────────────
  const brokenWriteApp = { datastore: () => ({ table: () => ({ insertRow: async () => { throw new Error('no such table'); } }) }) };
  check('a missing table fails open (false), never throws',
    (await feedback.submitFeedback(brokenWriteApp, {
      question: 'x', answer: 'y', note: 'z', reportedBy: 'a', convId: 'c',
    })) === false);

  // ── findSimilar ───────────────────────────────────────────────────────────
  const rows = [
    { Question: 'how many FIRs were filed in Belagavi last month', Note: 'The real count is 51.' },
    { Question: 'what is the weather in Mysuru', Note: 'unrelated' },
  ];
  const readApp = (r) => ({ zcql: () => ({ executeZCQLQuery: async () => r }) });

  const match = await feedback.findSimilar(readApp(rows), 'how many FIRs in Belagavi last month');
  check('a near-duplicate question finds the stored correction',
    match && match.note === 'The real count is 51.');

  const noMatch = await feedback.findSimilar(readApp(rows), 'who is the IO on FIR 4029');
  check('an unrelated question finds nothing', noMatch === null);

  check('an empty question finds nothing without reading the store',
    (await feedback.findSimilar(readApp(rows), '')) === null);

  // Rows can arrive wrapped under the table name, the same shape ZCQL
  // returns for every other table in this codebase.
  const wrappedRows = rows.map((r) => ({ AssistantFeedback: r }));
  const wrappedMatch = await feedback.findSimilar(readApp(wrappedRows), 'how many FIRs in Belagavi last month');
  check('a wrapped row shape (table-name keyed) is unwrapped correctly',
    wrappedMatch && wrappedMatch.note === 'The real count is 51.');

  // ── findSimilar: the store is absent ─────────────────────────────────────
  const brokenReadApp = { zcql: () => ({ executeZCQLQuery: async () => { throw new Error('no such table'); } }) };
  check('a missing table fails open (null), never throws',
    (await feedback.findSimilar(brokenReadApp, 'anything')) === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions/rag && node feedback.test.js`
Expected: `Error: Cannot find module './feedback'` — the module doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `functions/rag/feedback.js`:

```js
'use strict';

/**
 * Shared corrective feedback for the assistant.
 *
 * An officer flags an answer as wrong; the correction is stored once and
 * checked against every future question, from any officer — this is
 * deliberately NOT per-officer memory (see memory.js for that). A factual
 * correction is true regardless of who asks next.
 *
 * Matching is the same token-overlap technique memory.js's own recall()
 * uses for its local ranking, reused rather than duplicated.
 *
 * Console setup required once:
 *   Data Store table  AssistantFeedback
 *     FeedbackId Varchar, Question Varchar, AnswerSnippet Text, Note Text,
 *     ReportedBy Varchar, ConvId Varchar, CreatedAt BigInt
 *
 * Everything here is best-effort: if the table is not yet configured (or a
 * call to it fails for any reason), every read returns null and every write
 * returns false — the assistant behaves exactly as it did before this
 * module existed.
 */

const { tokens, overlapScore, OVERLAP_THRESHOLD } = require('./memory');

const FEEDBACK_TABLE = process.env.FEEDBACK_TABLE || 'AssistantFeedback';
// A bounded scan, not a paginated search — this list is expected to stay
// small (corrections, not conversation volume), and scoring is done locally
// in JS rather than in ZCQL, which has no text-similarity operator.
const MAX_SCAN_ROWS = 500;

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

// ZCQL wraps each row under the table name; every other table in this
// codebase unwraps the same way (see index.js's own unwrapRow for
// ChatConversations).
const unwrapRow = (r) => (r && r[FEEDBACK_TABLE] ? r[FEEDBACK_TABLE] : r || {});

async function submitFeedback(app, { question, answer, note, reportedBy, convId } = {}) {
  const q = clip(question, 500).trim();
  const n = clip(note, 2000).trim();
  if (!q || !n) return false;
  try {
    await app.datastore().table(FEEDBACK_TABLE).insertRow({
      FeedbackId: `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      Question: q,
      AnswerSnippet: clip(answer, 500),
      Note: n,
      ReportedBy: clip(reportedBy, 160),
      ConvId: clip(convId, 80),
      CreatedAt: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

async function findSimilar(app, question) {
  const q = String(question || '').trim();
  if (!q) return null;
  const qt = tokens(q);
  if (!qt.length) return null;
  let rows;
  try {
    rows = await app.zcql().executeZCQLQuery(
      `SELECT FeedbackId, Question, Note FROM ${FEEDBACK_TABLE} LIMIT ${MAX_SCAN_ROWS}`
    );
  } catch {
    return null; // table absent, or the read failed — no match, not an error
  }
  let best = null;
  for (const raw of rows || []) {
    const r = unwrapRow(raw);
    const score = overlapScore(qt, r.Question);
    if (score >= OVERLAP_THRESHOLD && (!best || score > best.score)) {
      best = { score, note: r.Note, question: r.Question };
    }
  }
  return best ? { note: best.note, question: best.question } : null;
}

module.exports = { FEEDBACK_TABLE, submitFeedback, findSimilar };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions/rag && node feedback.test.js`
Expected: `13 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add functions/rag/feedback.js functions/rag/feedback.test.js
git commit -m "feat(assistant): add feedback.js — shared corrective feedback storage and matching"
```

---

### Task 4: Wire the feedback lookup into the pipeline (`history` injection + confidence input)

**Files:**
- Modify: `functions/rag/index.js`:
  - Require `feedback` alongside the other module requires (line 10, next to `const memory = require('./memory');`).
  - Declare `let feedbackMatch = null;` alongside the other per-request `let` declarations (near line 4902, next to `let groundingResult = null;`).
  - Insert the lookup + `history` prepend right after the `if (sessionId) { ... }` memory block closes (after line 5605) and before the `// History is final here` comment (line 5606).
  - Wire `feedbackMatch` and `computeConfidence` into `respondWith` (around line 5164, where `groundless`/`shownSources` are computed) and into the JSON response (around line 5167's `json(res, 200, {...})` call).
- Modify: `functions/rag/injection.test.js` (add wiring-connectivity checks)
- Test: `functions/rag/agui.test.js` is unaffected; new checks live in `injection.test.js` per the codebase's own convention for "is this ingress actually wired" checks (see that file's header comment).

**Interfaces:**
- Consumes: `feedback.findSimilar` (Task 3), `computeConfidence` (Task 1).
- Produces: outer-scope `feedbackMatch` variable read by `respondWith`'s closure; a `confidence` field on the JSON response, present whenever `computeConfidence` returns non-null.

- [ ] **Step 1: Write the failing test**

Add to `functions/rag/injection.test.js`, after the existing memory-recall checks (after the line ending `'memory is background context nobody asked for, so dropping it is free');` and its neighbor about being "fenced even when clean"):

```js
// ── Feedback corrections reach every lane that shares history ──────────────
check('a matching correction is looked up once per question, not per lane',
  /feedbackMatch = await feedback\.findSimilar\(/.test(index));
check('  and a lookup failure is swallowed, never breaks the answer',
  /feedback\.findSimilar\([\s\S]{0,120}catch \(e\) \{[\s\S]{0,120}feedback lookup failed/.test(index));
check('a found correction is fenced and prepended into history, the same way long-term memory is',
  /if \(feedbackMatch\) \{[\s\S]{0,300}history = \[\{[\s\S]{0,100}guard\.fence\(/.test(index));
check('  so it reaches the tool loop for free via the existing history spread',
  /runToolLoop\(\{[\s\S]{0,200}history,/.test(index));
check('the ZCQL query generator does not receive history at all — a documented gap, not an oversight',
  !/zcql\.buildUserPrompt\(searchQuery, q, lastErr\)[\s\S]{0,50}\.\.\.\s*history/.test(index));
check('the RAG lane’s external call carries only the query and documents, not history',
  /callRag = async \(q, docs, timeoutMs\) => \{[\s\S]{0,80}const payload = \{ query: q \};/.test(index));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions/rag && node injection.test.js`
Expected: the first four new checks FAIL (`feedbackMatch`/the prepend don't exist yet); the last two pass already (they assert existing, unrelated code).

- [ ] **Step 3: Write minimal implementation**

In `functions/rag/index.js`, find the require block:

```js
const memory = require('./memory');
```

Add directly below it:

```js
const feedback = require('./feedback');
```

Find the per-request state declarations:

```js
    let groundingResult = null; // the verdict, shared with the decision record
```

Add directly below it:

```js
    let feedbackMatch = null; // a matching past correction, if any — shared, not per-officer
```

Find the end of the memory block:

```js
        if (longTermContext) {
          // Fenced even when clean. It is machine-written prose derived from
          // older conversations, not a system instruction someone authored.
          history = [{
            role: 'system',
            content: guard.fence(longTermContext, 'notes remembered from this officer’s earlier sessions'),
          }].concat(history);
        }
      }
    }
    // History is final here — the server buffer and recalled memory have both
    // had their say. Mirrored for the grounding check, which runs from a
    // closure defined above this line.
    turnHistory = history;
```

Replace it with:

```js
        if (longTermContext) {
          // Fenced even when clean. It is machine-written prose derived from
          // older conversations, not a system instruction someone authored.
          history = [{
            role: 'system',
            content: guard.fence(longTermContext, 'notes remembered from this officer’s earlier sessions'),
          }].concat(history);
        }
      }
    }

    // ── Shared feedback check ────────────────────────────────────────────
    // Unlike memory above, this is NOT gated on sessionId: a correction an
    // officer filed is true for every officer, not just the one who filed
    // it, so there is no per-officer scope to check against.
    try {
      feedbackMatch = await feedback.findSimilar(clearanceApp, query);
    } catch (e) {
      console.error('feedback lookup failed (non-fatal):', e && e.message);
    }
    if (feedbackMatch) {
      // Fenced the same way recalled memory is: machine-retrieved text, not
      // an instruction the officer typed. Reaches every lane that spreads
      // ...history (tools, chat, guide, fallback, the attachment/vision
      // answer) for free — but NOT ZCQL query generation or the external RAG
      // call, neither of which consumes history today. Those two still get
      // the confidence penalty below even though their prompt is unchanged.
      history = [{
        role: 'system',
        content: guard.fence(
          `An officer previously flagged a similar question's answer with this correction: ${feedbackMatch.note}. Take it into account; do not repeat the same mistake.`,
          'a correction filed against a similar past question'
        ),
      }].concat(history);
    }

    // History is final here — the server buffer, recalled memory and any
    // matching feedback have all had their say. Mirrored for the grounding
    // check, which runs from a closure defined above this line.
    turnHistory = history;
```

Now wire it into `respondWith`. Find:

```js
      const groundless = isNegative(text);
      const shownSources = groundless ? [] : citedSources;

      const sent = json(res, 200, {
        response_id: responseId,
        badge_id: badgeId(),
        answer,
        sources: shownSources,
        ...(groundingWarning
          ? { grounding: { warning: groundingWarning, ...groundingResult } }
          : {}),
```

Replace it with:

```js
      const groundless = isNegative(text);
      const shownSources = groundless ? [] : citedSources;
      const confidence = groundless
        ? null
        : computeConfidence({ source: payload.source, groundingResult, citedSources, feedbackMatch });

      const sent = json(res, 200, {
        response_id: responseId,
        badge_id: badgeId(),
        answer,
        sources: shownSources,
        ...(confidence !== null ? { confidence } : {}),
        ...(groundingWarning
          ? { grounding: { warning: groundingWarning, ...groundingResult } }
          : {}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions/rag && node injection.test.js`
Expected: all checks pass, `0 failed`.

Also run: `cd functions/rag && node confidence.test.js` (Task 1's test extracts a source slice by string search — confirm it still passes unchanged, since `computeConfidence`'s own source text was not moved).

- [ ] **Step 5: Commit**

```bash
git add functions/rag/index.js functions/rag/injection.test.js
git commit -m "feat(assistant): wire feedback lookup into history and confidence into every answer"
```

---

### Task 5: `POST /server/rag/feedback` — submission endpoint

**Files:**
- Modify: `functions/rag/index.js`:
  - Add a new dispatch line among the existing `path.endsWith(...)` routes (alongside line 4821's `/conversations/save` group).
  - Add `async function handleFeedback(req, res)`.
- Test: `functions/rag/feedback.test.js` is unaffected (it tests the module directly); add a new suite `functions/rag/feedbackroute.test.js` for the route-level behaviour, following the `handleConversations`-style source-slice + `new Function` execution pattern used by `csrf.test.js`/`geolocate.test.js` for testing one exported handler in isolation is not practical here (the handler is not exported and depends on `catalystSDK`), so this task instead adds structural checks to `apigate.test.js`, which already asserts route ordering the same way, plus behavioural checks against the already-tested `feedback.submitFeedback` from Task 3 (the route is a thin wrapper: parse body, resolve caller, call the already-tested function).

**Interfaces:**
- Consumes: `feedback.submitFeedback` (Task 3), `requestUser` (existing helper already used by `handleConversations`), `storeAuditEvents` (existing helper).
- Produces: `POST /server/rag/feedback` → `{ ok: true }` or `{ error }`.

`apigate.test.js` already has a generic check (`routeCount`/"all N data routes are dispatched after the gate", around line 22-25) that counts every `path.endsWith('` occurrence in the file and asserts only `/health`'s precedes the session gate — adding `/feedback` after the gate, the same way every other route already is, is automatically covered by that existing check with no new assertion needed for ordering. The one thing it does *not* cover is that `/feedback` actually routes to `handleFeedback` specifically — that's what this task's test adds.

- [ ] **Step 1: Write the failing test**

Add to `functions/rag/apigate.test.js`, after the existing `routeCount` check block (after the line `(src.slice(0, gateAt).match(/path\.endsWith\('/g) || []).length === 1);`):

```js
check('the feedback route calls the dedicated handler',
  /path\.endsWith\('\/feedback'\)\) return await handleFeedback\(req, res\)/.test(src));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions/rag && node apigate.test.js`
Expected: the new check FAILS — the route doesn't exist yet. (`routeCount`'s own check still passes either way, since it counts whatever routes currently exist.)

- [ ] **Step 3: Write minimal implementation**

In `functions/rag/index.js`, find:

```js
    if (path.endsWith('/conversations/list')) return await handleConversations(req, res, 'list');
    if (path.endsWith('/conversations/save')) return await handleConversations(req, res, 'save');
    if (path.endsWith('/conversations/delete')) return await handleConversations(req, res, 'delete');
```

Add directly below it:

```js
    if (path.endsWith('/feedback')) return await handleFeedback(req, res);
```

Then, directly above `async function handleConversations(req, res, action) {`, add:

```js
// An officer flagging an answer as wrong. Deliberately thin: the actual
// storage and matching logic lives in feedback.js, already tested on its
// own — this just resolves who's asking (never trusted from the body) and
// calls it.
async function handleFeedback(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const caller = await requestUser(app);
  const email = String((caller && caller.email_id) || '').trim().toLowerCase();
  if (!email) return json(res, 401, { error: 'Sign in to use the assistant.' });

  const ok = await feedback.submitFeedback(app, {
    question: body.question,
    answer: body.answer,
    note: body.note,
    reportedBy: email,
    convId: body.convId,
  });
  if (!ok) return json(res, 400, { error: 'Feedback could not be recorded — a question and a note are both required.' });

  try {
    const bucket = app.stratus().bucket(CONV_BUCKET);
    await storeAuditEvents(req, app, bucket, [{
      action: 'assistant-feedback', feature: 'Assistant', path: '/server/rag/feedback',
      detail: String(body.question || '').slice(0, 160),
    }], caller);
  } catch (e) {
    console.error('feedback audit log failed (non-fatal):', e && e.message);
  }

  return json(res, 200, { ok: true });
}

async function handleConversations(req, res, action) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions/rag && node apigate.test.js`
Expected: all checks pass, `0 failed`.

Run: `cd functions/rag && npm test` (full suite) to confirm nothing else regressed — this is the point where the new route touches the shared dispatch table other suites also assert against.

- [ ] **Step 5: Commit**

```bash
git add functions/rag/index.js functions/rag/apigate.test.js
git commit -m "feat(assistant): add POST /server/rag/feedback submission endpoint"
```

---

### Task 6: Frontend — confidence chip

**Files:**
- Modify: `react-app/src/utils/assistant.js` (`generateReply`'s return object)
- Modify: `react-app/src/pages/Assistant.js` (`botMsg` construction, new `ConfidenceChip` component, render call)
- Modify: `react-app/src/index.css` (chip styling)
- Test: `react-app/src/__smoke__/confidence.test.js` (new)

**Interfaces:**
- Consumes: `confidence` field on the backend JSON response (Task 4).
- Produces: `<ConfidenceChip confidence={m.confidence} />`, rendered only when `m.confidence` is a number.

- [ ] **Step 1: Write the failing test**

Create `react-app/src/__smoke__/confidence.test.js`:

```js
import React from 'react';
import { render } from '@testing-library/react';
import { ConfidenceChip } from '../pages/Assistant';

test('no confidence value renders nothing', () => {
  const { container } = render(<ConfidenceChip confidence={null} />);
  expect(container.innerHTML).toBe('');
});

test('a high score gets the default tone and shows the percentage', () => {
  const { getByText, container } = render(<ConfidenceChip confidence={82} />);
  expect(getByText('82%')).toBeTruthy();
  expect(container.querySelector('.as-confidence.tone-high')).not.toBeNull();
});

test('a mid score gets the amber tone', () => {
  const { container } = render(<ConfidenceChip confidence={55} />);
  expect(container.querySelector('.as-confidence.tone-medium')).not.toBeNull();
});

test('a low score gets the red tone', () => {
  const { container } = render(<ConfidenceChip confidence={20} />);
  expect(container.querySelector('.as-confidence.tone-low')).not.toBeNull();
});

test('tier boundaries: 70 is high, 69 is medium, 40 is medium, 39 is low', () => {
  expect(render(<ConfidenceChip confidence={70} />).container.querySelector('.tone-high')).not.toBeNull();
  expect(render(<ConfidenceChip confidence={69} />).container.querySelector('.tone-medium')).not.toBeNull();
  expect(render(<ConfidenceChip confidence={40} />).container.querySelector('.tone-medium')).not.toBeNull();
  expect(render(<ConfidenceChip confidence={39} />).container.querySelector('.tone-low')).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd react-app && CI=true npm test -- --watchAll=false src/__smoke__/confidence.test.js`
Expected: fails to import — `ConfidenceChip` is not exported from `Assistant.js` (it doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

In `react-app/src/utils/assistant.js`, find:

```js
    return {
      text, components, sources, source: data.source,
      grounding: data.grounding || null,
      protectedAccess: data.protected_access || null,
      // A file that carries an instruction aimed at this assistant is itself a
      // finding — somebody wrote that document expecting a system like this to
      // read it. Surfaced to the officer, not just to the audit trail.
      attachmentWarning: data.attachment_warning || null,
    };
```

Replace it with:

```js
    return {
      text, components, sources, source: data.source,
      confidence: typeof data.confidence === 'number' ? data.confidence : null,
      grounding: data.grounding || null,
      protectedAccess: data.protected_access || null,
      // A file that carries an instruction aimed at this assistant is itself a
      // finding — somebody wrote that document expecting a system like this to
      // read it. Surfaced to the officer, not just to the audit trail.
      attachmentWarning: data.attachment_warning || null,
    };
```

In `react-app/src/pages/Assistant.js`, find the `GroundingWarning` component definition (search for `function GroundingWarning`) and add a new export directly above it:

```js
// A computed, deterministic score (see computeConfidence in functions/rag/
// index.js) — never a model self-report. Rendered only when the backend
// actually returned one; chat/guide/negative answers carry no score at all
// because they are not factual claims.
export function ConfidenceChip({ confidence }) {
  if (typeof confidence !== 'number') return null;
  const tone = confidence >= 70 ? 'high' : confidence >= 40 ? 'medium' : 'low';
  return (
    <span
      className={`as-confidence tone-${tone}`}
      title="Based on retrieval grounding, source reliability, and prior feedback"
    >
      {confidence}%
    </span>
  );
}

function GroundingWarning({ grounding }) {
```

Find the `botMsg` construction:

```js
      const botMsg = {
        id: uid(),
        role: 'assistant',
        content: reply.text,
        components: reply.components,
        sources: reply.sources,
        source: reply.source,
        grounding: reply.grounding,
        protectedAccess: reply.protectedAccess,
        attachmentWarning: reply.attachmentWarning,
        ts: Date.now(),
      };
```

Replace it with:

```js
      const botMsg = {
        id: uid(),
        role: 'assistant',
        content: reply.text,
        components: reply.components,
        sources: reply.sources,
        source: reply.source,
        confidence: reply.confidence,
        grounding: reply.grounding,
        protectedAccess: reply.protectedAccess,
        attachmentWarning: reply.attachmentWarning,
        ts: Date.now(),
      };
```

Find the `as-msg-actions` row:

```js
                      {m.role === 'assistant' && m.content && (
                        <div className="as-msg-actions">
                          <button onClick={() => copyMessage(m)} title="Copy" aria-label="Copy response">
```

Replace it with:

```js
                      {m.role === 'assistant' && m.content && (
                        <div className="as-msg-actions">
                          <ConfidenceChip confidence={m.confidence} />
                          <button onClick={() => copyMessage(m)} title="Copy" aria-label="Copy response">
```

In `react-app/src/index.css`, find `.agui-card-open {` (the section right before `/* ── Assistant: markdown prose rendering ── */`) and, after that whole rule block (after its closing `}`), add:

```css
.as-confidence {
  font-size: 0.72rem;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 9999px;
  color: var(--text-2);
  background: var(--hover-overlay);
  margin-right: 4px;
}
.as-confidence.tone-low { color: var(--red); background: color-mix(in srgb, var(--red) 12%, transparent); }
.as-confidence.tone-medium { color: var(--gold); background: color-mix(in srgb, var(--gold) 14%, transparent); }
```

(`.tone-high` deliberately gets no override — it uses the same neutral default every other action-row element already uses, so a trustworthy answer doesn't visually shout.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd react-app && CI=true npm test -- --watchAll=false src/__smoke__/confidence.test.js`
Expected: `5 passed, 5 total`.

- [ ] **Step 5: Commit**

```bash
git add react-app/src/utils/assistant.js react-app/src/pages/Assistant.js react-app/src/index.css react-app/src/__smoke__/confidence.test.js
git commit -m "feat(assistant): show a confidence chip on every scored answer"
```

---

### Task 7: Frontend — `FeedbackDialog` and the bug icon

**Files:**
- Create: `react-app/src/components/FeedbackDialog.js`
- Modify: `react-app/src/pages/Assistant.js` (import, state, submit handler, render the bug icon + dialog)
- Modify: `react-app/src/index.css` (dialog body styling — reuses `.as-src-modal`/`.as-src-scrim`, which already exist)
- Test: `react-app/src/__smoke__/feedbackdialog.test.js` (new)

**Interfaces:**
- Consumes: `.as-src-modal` / `.as-src-scrim` CSS classes (already defined in `index.css` for `SourceCitations.js`'s `SourceViewer`).
- Produces: `<FeedbackDialog question={...} answer={...} convId={...} onSubmitted={...} onClose={...} />`; posts to `POST /server/rag/feedback`.

- [ ] **Step 1: Write the failing test**

Create `react-app/src/__smoke__/feedbackdialog.test.js`:

```js
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FeedbackDialog from '../components/FeedbackDialog';

const okFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });

beforeEach(() => {
  global.fetch = jest.fn(okFetch);
});

test('renders a textarea and a disabled submit button until text is entered', () => {
  render(<FeedbackDialog question="q" answer="a" convId="c" onSubmitted={() => {}} onClose={() => {}} />);
  expect(screen.getByRole('textbox')).toBeTruthy();
  expect(screen.getByText('Submit').closest('button')).toBeDisabled();
});

test('typing enables submit, and submitting posts to the feedback endpoint', async () => {
  const onSubmitted = jest.fn();
  render(<FeedbackDialog question="how many FIRs" answer="42" convId="conv-1" onSubmitted={onSubmitted} onClose={() => {}} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'The real count is 51.' } });
  expect(screen.getByText('Submit').closest('button')).not.toBeDisabled();
  fireEvent.click(screen.getByText('Submit'));
  await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/feedback$/);
  const body = JSON.parse(opts.body);
  expect(body).toMatchObject({ question: 'how many FIRs', answer: '42', convId: 'conv-1', note: 'The real count is 51.' });
});

test('Escape closes the dialog', () => {
  const onClose = jest.fn();
  render(<FeedbackDialog question="q" answer="a" convId="c" onSubmitted={() => {}} onClose={onClose} />);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
});

test('a failed submission shows an error rather than silently closing', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'nope' }) }));
  const onSubmitted = jest.fn();
  render(<FeedbackDialog question="q" answer="a" convId="c" onSubmitted={onSubmitted} onClose={() => {}} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wrong answer' } });
  fireEvent.click(screen.getByText('Submit'));
  await waitFor(() => expect(screen.getByText(/nope/i)).toBeTruthy());
  expect(onSubmitted).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd react-app && CI=true npm test -- --watchAll=false src/__smoke__/feedbackdialog.test.js`
Expected: fails to import — `../components/FeedbackDialog` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `react-app/src/components/FeedbackDialog.js`:

```js
import React, { useEffect, useRef, useState } from 'react';

// "What's wrong with this answer?" — reuses the exact popup styling
// SourceCitations.js already established (.as-src-modal / .as-src-scrim)
// for visual consistency, rather than a third dialog treatment.
export default function FeedbackDialog({ question, answer, convId, onSubmitted, onClose }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const panel = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    if (panel.current) panel.current.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    const trimmed = note.trim();
    if (!trimmed) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/server/rag/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer, convId, note: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setError(data.error || 'Could not record feedback.');
        setBusy(false);
        return;
      }
      onSubmitted();
    } catch (e) {
      setError(e.message || 'Could not record feedback.');
      setBusy(false);
    }
  };

  return (
    <>
      <div className="as-src-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Report an issue with this answer"
        className="as-src-modal as-feedback-dialog"
      >
        <header className="as-src-head">
          <div className="as-src-head-text">
            <h2 className="as-src-title">What's wrong with this answer?</h2>
          </div>
          <button type="button" className="as-src-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="as-src-body">
          <textarea
            className="as-feedback-textarea"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Describe what's incorrect or missing..."
            rows={5}
            autoFocus
          />
          {error && <p className="as-src-note">{error}</p>}
          <div className="as-feedback-actions">
            <button type="button" className="as-feedback-cancel" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="as-feedback-submit" onClick={submit} disabled={busy || !note.trim()}>
              {busy ? 'Submitting…' : 'Submit'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd react-app && CI=true npm test -- --watchAll=false src/__smoke__/feedbackdialog.test.js`
Expected: `5 passed, 5 total`.

- [ ] **Step 5: Commit**

```bash
git add react-app/src/components/FeedbackDialog.js react-app/src/__smoke__/feedbackdialog.test.js
git commit -m "feat(assistant): add FeedbackDialog for reporting a wrong answer"
```

---

### Task 8: Wire the bug icon into the message actions row

**Files:**
- Modify: `react-app/src/pages/Assistant.js` (import `Bug` from `lucide-react`, import `FeedbackDialog`, add dialog-open state, render the icon and conditionally the dialog)
- Modify: `react-app/src/index.css` (submitted-state icon styling, dialog textarea/actions styling)
- Test: `react-app/src/__smoke__/feedbackicon.test.js` (new)

**Interfaces:**
- Consumes: `FeedbackDialog` (Task 7).
- Produces: a submitted-state flag on each message (`m.feedbackSubmitted`), persisted the same way `m.feedback` (the existing thumbs up/down) already is — no new persistence mechanism.

No existing smoke test renders the full `Assistant.js` page in isolation (`grep -rln "pages/Assistant'" react-app/src/__smoke__/` returns nothing) — it's a large, stateful component wired to the Catalyst SDK, router, and session storage, with no established mocking harness to reuse. `FeedbackDialog` itself is already fully behavior-tested in isolation by Task 7 (open, type, submit, error, Escape). What Task 8 actually adds is *wiring*: the icon exists in the row, it's disabled/shows a different state once submitted, and `markFeedbackSubmitted` sets that state correctly. This is exactly the shape `functions/rag/injection.test.js` already tests for backend wiring (source-text structural assertions rather than executing the whole handler) — the same technique applies here, on `Assistant.js`'s source, and `markFeedbackSubmitted` is tested directly by extracting and running it, the same `new Function`-from-source-slice technique used throughout `functions/rag/*.test.js` (there is no frontend precedent for this exact technique, but the underlying idea — lift one pure/near-pure function out of a large file and run it directly against a fake `setSessions` — needs no JSX rendering and no component mocking, so it transfers cleanly).

- [ ] **Step 1: Write the failing test**

Create `react-app/src/__smoke__/feedbackicon.test.js`:

```js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'pages', 'Assistant.js'), 'utf8');

test('Bug is imported from lucide-react for the report-an-issue icon', () => {
  expect(/Bug\s*[,}]/.test(src.slice(0, src.indexOf('} from \'lucide-react\'')))).toBe(true);
});

test('FeedbackDialog is imported', () => {
  expect(/import FeedbackDialog from '\.\.\/components\/FeedbackDialog'/.test(src)).toBe(true);
});

test('the bug icon sits in the same actions row as copy/thumbs up/down, after ThumbsDown', () => {
  const actionsRow = src.slice(src.indexOf('as-msg-actions'), src.indexOf('as-msg-actions') + 3000);
  const thumbsDownAt = actionsRow.indexOf('Bad response');
  const bugAt = actionsRow.indexOf('<Bug ');
  expect(thumbsDownAt).toBeGreaterThan(-1);
  expect(bugAt).toBeGreaterThan(thumbsDownAt);
});

test('the icon is disabled and relabeled once feedback was submitted for that message', () => {
  const btnSrc = src.slice(src.indexOf('m.feedbackSubmitted ? \'active\''), src.indexOf('<Bug '));
  expect(/disabled=\{m\.feedbackSubmitted\}/.test(src)).toBe(true);
  expect(/Feedback already recorded for this answer/.test(btnSrc)).toBe(true);
});

test('clicking when already submitted does not reopen the dialog', () => {
  expect(/onClick=\{\(\) => !m\.feedbackSubmitted && setFeedbackFor\(m\.id\)\}/.test(src)).toBe(true);
});

test('markFeedbackSubmitted sets feedbackSubmitted on the right message and clears feedbackFor', () => {
  // Same technique functions/rag/*.test.js already uses throughout: lift a
  // complete `const name = (...) => { ... };` statement out of the real
  // source and execute it directly, rather than asserting on how it reads.
  const startIdx = src.indexOf('const markFeedbackSubmitted =');
  const endIdx = src.indexOf('\n  };', startIdx) + 5; // include the closing `};`
  const fnSrc = src.slice(startIdx, endIdx);
  let capturedUpdater = null;
  const fakeSetSessions = (updater) => { capturedUpdater = updater; };
  let capturedFeedbackFor = 'unset';
  const fakeSetFeedbackFor = (v) => { capturedFeedbackFor = v; };
  // eslint-disable-next-line no-new-func
  const markFeedbackSubmitted = new Function(
    'setSessions', 'setFeedbackFor', 'activeId',
    `${fnSrc}\nreturn markFeedbackSubmitted;`
  )(fakeSetSessions, fakeSetFeedbackFor, 'session-1');
  markFeedbackSubmitted('msg-2');
  const result = capturedUpdater([
    { id: 'session-1', messages: [{ id: 'msg-1' }, { id: 'msg-2' }] },
    { id: 'session-2', messages: [{ id: 'msg-2' }] },
  ]);
  expect(result[0].messages.find((m) => m.id === 'msg-2').feedbackSubmitted).toBe(true);
  expect(result[0].messages.find((m) => m.id === 'msg-1').feedbackSubmitted).toBeUndefined();
  expect(result[1]).toEqual({ id: 'session-2', messages: [{ id: 'msg-2' }] }); // other session untouched
  expect(capturedFeedbackFor).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd react-app && CI=true npm test -- --watchAll=false src/__smoke__/feedbackicon.test.js`
Expected: every check fails — none of this wiring exists in `Assistant.js` yet (the first two on missing imports, the rest on `indexOf` returning `-1` and producing empty/garbage slices that don't match).

- [ ] **Step 3: Write minimal implementation**

In `react-app/src/pages/Assistant.js`, add `Bug` to the `lucide-react` import:

```js
import {
  Plus, MessageSquare, Trash2,
  Paperclip, Mic, ArrowUp, X, Shield, FileText, PanelLeft,
  Copy, Check, ThumbsUp, ThumbsDown, RotateCcw, MoreVertical,
  Star, Pencil, FileDown, CheckSquare, AlertTriangle, ShieldAlert, Bug,
} from 'lucide-react';
```

Add the import for `FeedbackDialog` next to the other component imports (search for `import SourceCitations`):

```js
import SourceCitations, { SourceViewer } from '../components/SourceCitations';
import FeedbackDialog from '../components/FeedbackDialog';
```

Add dialog-open state near the other `useState` declarations at the top of the component (search for `const [citation, setCitation]` and add alongside it):

```js
  const [feedbackFor, setFeedbackFor] = useState(null); // the message currently being reported, or null
```

Add a helper next to `setFeedback` (the existing thumbs up/down toggle):

```js
  // Marks a message as reported, the same way m.feedback already persists
  // across reloads (saved with the rest of the session's messages).
  const markFeedbackSubmitted = (msgId) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId
          ? {
              ...s,
              messages: s.messages.map((m) =>
                m.id === msgId ? { ...m, feedbackSubmitted: true } : m
              ),
            }
          : s
      )
    );
    setFeedbackFor(null);
  };
```

In the `as-msg-actions` row, find the closing of the `ThumbsDown` button (the `</button>` right before `</div>` that closes `as-msg-actions`):

```js
                          <button
                            className={m.feedback === 'down' ? 'active down' : ''}
                            onClick={() => setFeedback(m.id, 'down')}
                            title="Bad response"
                            aria-label="Bad response"
                            aria-pressed={m.feedback === 'down'}
                          >
                            <ThumbsDown size={15} />
                          </button>
                        </div>
```

Replace it with:

```js
                          <button
                            className={m.feedback === 'down' ? 'active down' : ''}
                            onClick={() => setFeedback(m.id, 'down')}
                            title="Bad response"
                            aria-label="Bad response"
                            aria-pressed={m.feedback === 'down'}
                          >
                            <ThumbsDown size={15} />
                          </button>
                          <button
                            className={m.feedbackSubmitted ? 'active' : ''}
                            onClick={() => !m.feedbackSubmitted && setFeedbackFor(m.id)}
                            title={m.feedbackSubmitted ? 'Feedback already recorded for this answer' : 'Report an issue'}
                            aria-label={m.feedbackSubmitted ? 'Feedback already recorded for this answer' : 'Report an issue'}
                            disabled={m.feedbackSubmitted}
                          >
                            <Bug size={15} />
                          </button>
                        </div>
```

Find the render of `SourceViewer` (search for `{citation && (` near the bottom of the component's JSX) and add the `FeedbackDialog` render alongside it:

```js
      {feedbackFor && (() => {
        const m = messages.find((msg) => msg.id === feedbackFor);
        if (!m) return null;
        return (
          <FeedbackDialog
            question={lastUserQuestion(m.id)}
            answer={m.content}
            convId={activeId}
            onSubmitted={() => markFeedbackSubmitted(m.id)}
            onClose={() => setFeedbackFor(null)}
          />
        );
      })()}
```

(Place this block adjacent to wherever `{citation && <SourceViewer .../>}` already renders, so both dialogs follow the same top-level-overlay convention. `lastUserQuestion` and `messages` are already in scope in this component — `lastUserQuestion` is the same helper already used by `ProtectedAccessPanel`'s `onRequest` a few lines above.)

In `react-app/src/index.css`, add near the `.as-confidence` rules from Task 6:

```css
.as-msg-actions button.active { color: var(--blue-500); }
.as-feedback-textarea {
  width: 100%;
  min-height: 100px;
  padding: 10px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-1);
  color: var(--text-1);
  font: inherit;
  resize: vertical;
}
.as-feedback-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.as-feedback-cancel, .as-feedback-submit {
  padding: 7px 14px;
  border-radius: var(--radius);
  font-size: 0.82rem;
  font-weight: 500;
}
.as-feedback-cancel { background: transparent; border: 1px solid var(--border); color: var(--text-2); }
.as-feedback-submit { background: var(--blue-500); border: none; color: white; }
.as-feedback-submit:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd react-app && CI=true npm test -- --watchAll=false src/__smoke__/feedbackicon.test.js`
Expected: passes.

Then run the full frontend and backend suites plus lint, build, and the a11y gate, to confirm no regressions from the whole feature:

```bash
cd react-app && CI=true npm test -- --watchAll=false
cd react-app && npx eslint src --ext .js --ignore-pattern '__smoke__'
cd functions/rag && npm test
cd react-app && npm run build
cd .. && node scripts/a11y-check.test.js && node scripts/a11y-check.js
```

Expected: all green, matching the pattern established for every prior feature this session.

- [ ] **Step 5: Commit**

```bash
git add react-app/src/pages/Assistant.js react-app/src/index.css react-app/src/__smoke__/feedbackicon.test.js
git commit -m "feat(assistant): wire the bug-report icon and feedback dialog into the message actions row"
```

---

## Explicitly not built (carried from the spec — do not add these without a new design discussion)

- No moderation/approval gate on submitted feedback.
- No officer-facing transparency for a matched correction.
- No semantic/QuickML matching — token overlap only.
- No edit or multi-submit flow for feedback on one message.
- No confidence breakdown UI.
- No `history` injection point for ZCQL generation or the external RAG call — confidence penalty only for those two lanes.
