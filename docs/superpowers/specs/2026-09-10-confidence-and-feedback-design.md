# Answer confidence score + a shared feedback loop — design spec

## Why

Every assistant answer today is presented with equal visual weight whether
it came from a deterministic Data Store query or a general-knowledge
fallback with no citations at all — an officer has no signal for how much
to trust a given answer beyond reading the citations themselves. And when
an answer is wrong, there is no way to correct it: the existing thumbs-up/
thumbs-down icons in `Assistant.js` only toggle local component state that
gets saved into the chat transcript blob and is never read back by
anything — reported problems vanish the moment the conversation is no
longer open, and the same wrong answer keeps recurring for every officer
who asks a similar question.

This closes both gaps: a computed, deterministic confidence score on every
factual answer, and a persistent, shared feedback loop — an officer flags
what's wrong, and the correction is taken into account the next time
anyone asks a similar question.

## What this is

Two independent but related additions to the existing assistant pipeline
in `functions/rag/index.js`:

1. **Confidence score** — a 0–100 number computed from signals the
   pipeline already produces (which lane answered, `grounding.js`'s
   hallucination check, whether the answer cites anything, and — new —
   whether a similar past question was flagged). No new model call, no
   self-reported number: this reuses the pipeline's existing "never trust
   the model to self-police" posture (clearance filtering before
   generation, `guard.js` as defense in depth over `redaction.js`, etc.).
2. **Feedback loop** — a new `functions/rag/feedback.js` module backed by
   a new Data Store table, following the exact pattern
   `ChatConversations` already established for a writable, non-seeded
   table. An officer flags an answer via a new bug icon; the note is
   stored; every subsequent question (from any officer — feedback is
   shared, not per-officer) is checked against stored feedback using the
   same token-overlap technique `memory.js`'s `recall()` already uses,
   and a match is injected into the model's context as a corrective note.
   The match is **not** shown to the officer — it silently informs the
   answer, per the explicit decision below.

## Confidence score

### Signals combined

All of these already exist in the pipeline by the time `respondWith` is
called, except the new feedback match:

| Signal | Source | Effect |
|---|---|---|
| Answering lane | `source` param to `respondWith` | Sets the baseline (below) |
| Grounding | `groundingResult` (already computed in `respondWith`, from `grounding.js`) | `checked && !grounded` → −30 |
| Citations | `citedSources` (already computed in `respondWith`) | Zero citations on a lane that normally cites → −15 |
| Past feedback | new: `feedback.findSimilar()` result, threaded through from the pipeline step below | A match found → −25 |

### Baselines per lane

Every real value the existing `source` variable/param already takes,
confirmed against `index.js` rather than assumed — a lane missing from
this table would silently fall through to whatever default
`computeConfidence` picks, which must never happen unnoticed:

- `zcql` → 85 (a deterministic query against the Data Store; the most
  trustworthy shape an answer here takes)
- `digitised-records` → 75 (a real matched scanned record)
- `attachment`, `vision` → 75 (answering by reading a real attached
  document/image directly — same trust level as a matched scanned
  record, for the same reason)
- `tools` → 75 (multi-step reasoning/tool calls — more room for a wrong
  turn than a single query)
- `rag` → 70 (knowledge-base retrieval)
- `fallback` → 40 (general knowledge, no citations possible by
  construction)
- `chat`, `guide`, `command`, `guardrail`, and any answer `isNegative()`
  already flags as "not found" → **no score at all**
  (`confidence: undefined`, omitted from the response). None of these are
  factual claims with a truth value — "hi", `/help`'s command list, a
  refused prompt-exfiltration attempt, and "I don't have that" don't get
  a percentage.
- Any other/future `source` value not yet listed here → no score, not a
  guessed default — `computeConfidence` fails closed on an unrecognised
  lane rather than assigning it a baseline nobody chose.

### Function

`function computeConfidence({ source, groundingResult, citedSources, feedbackMatch })`
— a new pure function in `index.js`, next to `sanitizeForDisplay` and the
other small pure helpers. Returns `null` for the no-score lanes/cases
above, otherwise a number clamped to `[5, 98]` (never claims certainty
either way). Wired into `respondWith` right after `groundingResult` is
computed (it already has everything else it needs at that point) and
added to the JSON response as a new top-level `confidence` field,
alongside the existing `grounding`/`protected_access` optional fields —
same pattern, present only when meaningful.

## Feedback storage

### New Data Store table: `AssistantFeedback`

Console-created, exactly like `ChatConversations` (Catalyst cannot create
tables from code). Env override `FEEDBACK_TABLE`, default
`AssistantFeedback`, matching `CONV_TABLE`'s own convention.

| Column | Type | Notes |
|---|---|---|
| `FeedbackId` | Varchar | Generated (timestamp + random suffix, same shape `ConvId` already uses elsewhere) |
| `Question` | Varchar | The English question text — post `normaliseToEnglish()` (`index.js`), the same translation step every lane already runs a non-English question through before doing anything else with it. Matching is token-overlap over English text only, same scope `memory.js`'s own matching already has. |
| `AnswerSnippet` | Text | First 500 chars of the flagged answer — audit context, not matched against |
| `Note` | Text | The officer's free-text explanation of what's wrong — this is the actual correction |
| `ReportedBy` | Varchar | Badge/email, resolved server-side from the session, never trusted from the request body (same rule every other write in this codebase follows) |
| `ConvId` | Varchar | Traceability back to the conversation, when available |
| `CreatedAt` | BigInt | Epoch ms |

No `Status`/moderation column in v1 — see "Explicitly not built."

### `functions/rag/feedback.js`

New module, shaped like `memory.js` and `sanctions.js`: every function is
best-effort and fails open. If the table doesn't exist yet (console setup
pending) or any read/write throws, the assistant behaves exactly as it
does today — no feedback influence, no confidence penalty, no error
surfaced to the officer.

- `async function submitFeedback(app, { question, answer, note, reportedBy, convId })`
  → `app.datastore().table(FEEDBACK_TABLE).insertRow({...})`. Returns
  `true`/`false`.
- `async function findSimilar(app, question)` → reads up to 500 rows
  (`SELECT FeedbackId, Question, Note FROM AssistantFeedback LIMIT 500`,
  same `executeZCQLQuery` + `unwrapRow` shape `index.js` already uses for
  `ChatConversations`), then scores each stored `Question` against the
  new one with the **same `tokens()`/overlap-ratio function
  `memory.js` already defines** — exported from `memory.js` rather than
  duplicated, since it's the identical calculation (token overlap ratio,
  same `>= 0.2` threshold). Returns the single best match above threshold
  (`{ note, question }`) or `null`. No live network/LLM call — this is a
  bounded local computation over a bounded row set, so it costs one extra
  Data Store read per question, not a metered LLM call.

## Pipeline wiring

### Checking feedback on every question

`index.js` already has an "Assembled memory context" step that runs once,
early, before the router, gated on `sessionId` (per-officer memory only
makes sense with a session). This is a **separate** step, added right
after it, unconditional (feedback is shared, not per-officer, so there's
no session to gate on):

```js
let feedbackMatch = null;
try {
  feedbackMatch = await feedback.findSimilar(clearanceApp, query);
} catch (e) {
  console.error('feedback lookup failed (non-fatal):', e && e.message);
}
```

When `feedbackMatch` is non-null, its note is prepended into `history` as
a fenced `system` turn — the *exact* mechanism already used for
`longTermContext` a few lines above it (`guard.fence(...)` wrapping a
sentence like *"An officer previously flagged a similar question's answer
with this correction: `<note>`. Take it into account; do not repeat the
same mistake."*, prepended the same way). This reaches every lane that
already spreads `...history` into its own call — `tools` (via
`runToolLoop`'s `history` param), `chat`, `guide`, `fallback`, and the
vision/attachment answer — for free, with no new parameter threading.

**Two lanes do not receive it as prompt content, and this is a known,
accepted gap rather than a claim of full coverage:**
- **ZCQL generation** (`zcql.ZCQL_SYSTEM` / `buildUserPrompt`) takes no
  `history` at all today — it's a single-shot query generator. A
  correction note doesn't obviously help a query-generation prompt
  anyway (the fix for "the query was wrong" is a better query, not a
  caveat), so this is left alone in v1.
- **The RAG lane** (`callRag`) is a call to an external microservice that
  takes only `{query, documents}` — there is no system prompt of ours to
  inject into; we don't control what runs on the other end of that call.

Both lanes still get the **confidence penalty** below when a match is
found — the score reflects the known issue even where the answer's text
itself can't be steered by it.

`computeConfidence` is called exactly once, inside `respondWith` itself —
not by each of the ~9 call sites individually. It already runs there with
`groundingResult` and `citedSources` (both already local variables inside
`respondWith` by that point) and `payload.source` (already passed in by
every caller). `feedbackMatch` is the one new input: an outer-scope `let`
in the request handler, set once by the lookup above and read by
`respondWith`'s closure exactly the way `redactionLog`/`groundingResult`
already are — no new parameter threading through any lane.

### Submission endpoint

New route, after the existing gates (session required, same as every
other assistant route — no new role restriction beyond "can use the
assistant at all"):

`POST /server/rag/feedback` — body `{ question, answer, convId, note }`.
Resolves `reportedBy` server-side via the existing `myRole`/caller
resolution the rest of `index.js` already uses (never from the request
body). Calls `feedback.submitFeedback`. Responds `{ ok: true }` or
`{ error }`; never throws into a 500 for a store that's merely absent.

Writes one entry via `storeAuditEvents` — the same generic mechanism
every other write route in this file already calls (`{action:
'assistant-feedback', feature: 'Assistant', path: '/server/rag/feedback',
detail: ...}`) — a feedback submission is worth a record of who flagged
what, same as any other write here.

## Frontend

### Confidence chip

New small component (or inline in `Assistant.js`, matching how
`GroundingWarning` is a small local component today), rendered next to
the existing `as-msg-actions` row, only when `m.confidence` is a number.
Three tone tiers reusing existing color tokens (the same
`--red`/`--gold`/default-text-color vocabulary `AguiRenderer.js`'s new
components already established): `< 40` → red/low, `40–69` → amber/
medium, `≥ 70` → default/high. A static tooltip states what it's derived
from ("Based on retrieval grounding, source reliability, and prior
feedback") — no interactive breakdown UI; that's more surface than a
single number needs.

### Feedback bug icon

New button in the existing `as-msg-actions` row (alongside Copy/
ThumbsUp/ThumbsDown — additive, those are untouched), a `Bug`/`Flag`
icon from `lucide-react` (already the icon library used throughout this
file). Opens a new `FeedbackDialog` component styled with the **same**
`.as-src-modal`/`.as-src-scrim` classes `SourceCitations.js` already
defines — one textarea ("What's wrong with this answer?"), Cancel/
Submit. On submit, `POST /server/rag/feedback` with the message's
question/answer/convId, show a brief confirmation, and mark that message
locally (`m.feedbackSubmitted`) so the icon shows a filled/submitted
state and re-clicking shows "Feedback already recorded for this answer"
rather than opening the form again — no edit/multi-submit flow in v1.

## Error handling

- `AssistantFeedback` table absent: `findSimilar` and `submitFeedback`
  both catch and return `null`/`false` — assistant behaves exactly as
  before, submission endpoint responds `{ error: 'Feedback is not
  configured.' }` rather than a 500.
- `findSimilar` timeout or malformed rows: treated as "no match," never
  blocks or slows the answer past a short bound (same "best-effort,
  never the reason a question failed" posture `memory.js` already
  documents for itself).
- A blank `note` on submission: rejected client-side (Submit disabled)
  and server-side (`{ error }`), matching how other write endpoints in
  this codebase validate required fields.

## Testing

`functions/rag/confidence.test.js` — table-driven, pure function, no I/O:
every lane's baseline, each individual penalty applied in isolation and
combined, clamping at both ends, and the no-score cases (`chat`, `guide`,
a negative answer) returning `null`.

`functions/rag/feedback.test.js` — mirrors `memory.test.js`'s shape:
- Matching (pure, once the shared token-overlap function is exported from
  `memory.js`): a near-duplicate question matches, an unrelated one
  doesn't, threshold behaviour at the boundary.
- I/O, using the same `fakeApp` pattern `tools.test.js` already uses for
  ZCQL (`{ zcql: () => ({ executeZCQLQuery: async () => rows }) }` for
  reads, an equivalent stub for `datastore().table().insertRow` for
  writes): `submitFeedback` inserts the right shape; `findSimilar` reads,
  scores, and returns the top match or `null`; either function throwing
  (table absent) is swallowed, not propagated.

`functions/rag/index.js` wiring — extend the existing lane tests
(`tools.test.js`'s `route` slice): the feedback lookup happens once per
question, its result reaches `computeConfidence` inside `respondWith`,
and its note (when present) is prepended into `history` and therefore
reaches every lane that spreads `...history` — added to
`injection.test.js`, which already covers `longTermContext`'s own fenced
prepend into the same variable. A companion check confirms ZCQL
generation and the RAG lane's `callRag` call are unaffected by this
prepend (they don't consume `history`), so the documented gap stays true
rather than silently closing or silently regressing.

Frontend: a new `feedback.test.js` smoke test for `FeedbackDialog` (opens,
requires non-empty text, submits, shows the submitted state) and the
confidence chip's tone-threshold boundaries; extends `citations.test.js`
or a sibling file rather than duplicating its render setup.

## Explicitly not built in v1

- **No moderation/approval gate.** A submitted flag takes effect
  immediately for every officer. `ReportedBy` is stored for
  accountability (an admin could be given a view onto the raw table
  later), but nothing reviews a flag before it starts influencing
  answers. Revisit if this proves to be a problem in practice.
- **No officer-facing transparency for a matched correction.** The
  officer asking the new question is not told a past flag existed or
  what it said — it silently shapes the model's context only. (The
  *reporting* officer already knows they filed it; this is about the
  *next* officer who benefits from it.)
- **No semantic/QuickML matching.** Token overlap only, same threshold
  and technique `memory.js` already uses locally. If this proves too
  narrow (misses real paraphrases) or too loose (false positives), the
  next step would be reusing the QuickML knowledge-base search the RAG
  lane and `memory.recall()` already call — not built here.
- **No edit or multi-submit flow** for feedback on a single message —
  one submission per message per conversation, then the icon just shows
  it was recorded.
- **No confidence breakdown UI** — a single number and tone, not a
  drill-down into which signals contributed what.
