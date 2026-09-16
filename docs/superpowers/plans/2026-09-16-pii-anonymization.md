# PII Anonymization Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an officer paste text and get back a version with names, places, dates/times, and domain identifiers (FIR/case numbers, phone numbers) replaced by consistent placeholders, with an authorized role able to reverse a specific anonymization later.

**Architecture:** A new sibling module `functions/rag/anonymize.js` (regex recognizers + Zia NER + overlap resolution + a consistent instance-counter anonymizer), wired into the existing single-function router as two routes (`/anonymize/text`, `/anonymize/reveal`) that inherit the existing session/CSRF/rate-limit gates automatically. Reversal is gated by the existing `PROTECTED_CLEARANCE` tier from `redaction.js` and the map is stored server-side in Stratus, never returned to the caller. A new frontend page posts to these routes.

**Tech Stack:** Node.js (Catalyst advancedio function), Catalyst Zia NER (`zia.getNERPrediction`, already used elsewhere in this function via `vision.js`), Stratus object storage, React (CRA5) + react-router-dom 7 on the frontend. No new npm dependency, no new runtime.

**Spec:** `docs/superpowers/specs/2026-09-16-pii-anonymization-design.md`

## Global Constraints

- One Catalyst function only (`functions/rag/index.js` + sibling modules) — no new service, no new runtime, no new npm dependency (spec: "Architecture").
- New routes are added after `requireSession` in the router dispatch, so they inherit CSRF/IP-block/session/rate-limit gates automatically (spec: "Architecture"; `CLAUDE.md` "Request order... is load-bearing").
- `/anonymize/text` has no clearance requirement; `/anonymize/reveal` requires `clearanceOf(role) >= PROTECTED_CLEARANCE` (value `3`, from `functions/rag/redaction.js`) (spec: "Reversibility").
- The raw entity map is never returned to the caller — only `mapId`, `anonymizedText`, `entityCounts` (spec: "Reversibility").
- Same value maps to the same placeholder within one call only; cross-call consistency is explicitly out of scope (spec: "Anonymization").
- Both new routes are added to `METERED_ROUTES` in `functions/rag/index.js` (spec: "Architecture").
- Text-only input, no image/OCR path, no batch/dataset mode (spec: "Purpose").
- Zia NER offsets are not trusted blindly — an entity is only kept if `text.slice(start, start + token.length) === token`; a mismatch drops the entity rather than corrupting the text (this plan's resolution of the spec's open risk #1 — see Task 2).

---

## File Structure

- **Create** `functions/rag/anonymize.js` — pure entity-detection/anonymization/reveal logic. No HTTP, no auth, no Stratus I/O (same split as `guard.js` / `redaction.js`).
- **Create** `functions/rag/anonymize.test.js` — plain `check(name, cond)` suite, no framework, picked up automatically by `npm test`.
- **Modify** `functions/rag/index.js` — `require('./anonymize')`, `handleAnonymize`, two routes, `METERED_ROUTES` regex.
- **Create** `frontend/src/utils/anonymize.js` — thin fetch client (`anonymizeText`, `revealText`).
- **Create** `frontend/src/pages/Anonymize.js` — the page.
- **Modify** `frontend/src/App.tsx` — import + route.
- **Modify** `frontend/src/utils/access.js` — `FEATURES` entry (route guard; open to every role).
- **Modify** `frontend/src/components/Sidebar.js` — one menu item in the profile dropdown (same place as "Help center"), not the main module nav — this is a general utility, not a case-work module.
- **Modify** `frontend/src/index.css` — `.an-*` styles, appended after the existing `.hc-*` (Help Center) block.

No i18n file changes: the profile-dropdown menu items in this codebase ("View profile", "Help center") are hardcoded English, not run through `t()` — the new "Anonymize" item follows that same existing precedent, so `frontend/src/__smoke__/i18n.test.js`'s key-parity check is untouched.

---

### Task 1: Regex recognizers + overlap resolution

**Files:**
- Create: `functions/rag/anonymize.js`
- Create: `functions/rag/anonymize.test.js`

**Interfaces:**
- Produces: `regexEntities(text: string) => Array<{type: string, start: number, end: number, text: string, score: number}>`
- Produces: `resolveOverlaps(entities: Array<Entity>) => Array<Entity>` (sorted by `start` ascending, no two entries overlapping, higher `score` wins a conflict)
- Produces: `REGEX_RECOGNIZERS` (array of `{type, re, score}`), exported so Task 2/3 code and tests can introspect it if needed.

- [ ] **Step 1: Write the failing test**

Create `functions/rag/anonymize.test.js`:

```js
// PII detection/anonymization core. Run: node functions/rag/anonymize.test.js
const anonymize = require('./anonymize');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// Locates a substring by value instead of hand-counted indices, so a typo in
// the fixture text can't silently desync the expected span.
const span = (text, value, from = 0) => {
  const start = text.indexOf(value, from);
  if (start < 0) throw new Error(`fixture bug: "${value}" not found in "${text}"`);
  return { start, end: start + value.length, text: value };
};

// ── Regex recognizers ───────────────────────────────────────────────────────
{
  const text = 'FIR 42/2026 was registered on 04/03/2026 after a call from 9876543210.';
  const hits = anonymize.regexEntities(text);
  const firHit = hits.find((h) => h.type === 'FIR_NUMBER');
  check('FIR number is recognised', !!firHit && firHit.text === '42/2026');
  const dateHit = hits.find((h) => h.type === 'DATE');
  check('DD/MM/YYYY date is recognised', !!dateHit && dateHit.text === '04/03/2026');
  const phoneHit = hits.find((h) => h.type === 'PHONE');
  check('10-digit Indian mobile number is recognised', !!phoneHit && phoneHit.text === '9876543210');
  check('every regex hit carries the matched span exactly',
    hits.every((h) => text.slice(h.start, h.end) === h.text));
}

// ── Overlap resolution ──────────────────────────────────────────────────────
{
  const text = 'Ravi Kumar was seen near Chennai.';
  const shortHit = { type: 'PERSON', ...span(text, 'Ravi Kuma'), score: 0.6 };
  const longHit = { type: 'PERSON', ...span(text, 'Ravi Kumar'), score: 0.9 };
  const locHit = { type: 'LOCATION', ...span(text, 'Chennai'), score: 0.8 };
  const kept = anonymize.resolveOverlaps([shortHit, longHit, locHit]);
  check('the higher-scoring entity wins an overlap',
    kept.length === 2 && kept[0].text === 'Ravi Kumar');
  check('non-overlapping entities all survive', kept.some((e) => e.text === 'Chennai'));
  check('kept entities are sorted by start position',
    kept.every((e, i) => i === 0 || kept[i - 1].start <= e.start));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node functions/rag/anonymize.test.js`
Expected: `Error: Cannot find module './anonymize'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `functions/rag/anonymize.js`:

```js
// PII anonymization: entity detection (regex + Zia NER), consistent
// per-call placeholder assignment, and reversible mapping helpers.
//
// Pure logic only — no HTTP, no auth, no Stratus I/O. That lives in
// index.js's handleAnonymize, the same split as guard.js / redaction.js.
//
// Modeled on the entity-detection design in
// github.com/Saurabhrajput1234/KSP_Project-Sherlock (regex recognizers layered
// over NER, overlap resolution, consistent instance-counter placeholders) —
// reimplemented for this codebase's stack (no Python/Presidio/spaCy here).

// Domain regex recognizers. Scored 1 so a deterministic domain pattern always
// wins an overlap against a fuzzy NER guess on the same span.
const REGEX_RECOGNIZERS = [
  { type: 'FIR_NUMBER', re: /\b\d{1,6}\/\d{4}\b/g, score: 1 },
  { type: 'PHONE', re: /\b[6-9]\d{9}\b/g, score: 1 },
  { type: 'DATE_TIME', re: /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\b/g, score: 1 },
  { type: 'DATE', re: /\b\d{2}[/-]\d{2}[/-]\d{4}\b/g, score: 1 },
];

function regexEntities(text) {
  const hits = [];
  for (const { type, re, score } of REGEX_RECOGNIZERS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      hits.push({ type, start: m.index, end: m.index + m[0].length, text: m[0], score });
      if (m[0].length === 0) re.lastIndex++; // guard against a zero-width pattern looping forever
    }
  }
  return hits;
}

// Greedy sweep: sort by start (ties broken by higher score first), keep an
// entity only if it doesn't overlap anything already kept. Equivalent in
// intent to the reference's overlap resolution (higher-confidence entity wins
// a conflict) but a single sorted pass instead of an O(n^2) pairwise scan.
function resolveOverlaps(entities) {
  const sorted = [...entities].sort((a, b) => a.start - b.start || b.score - a.score);
  const kept = [];
  for (const e of sorted) {
    const overlaps = kept.some((k) => e.start < k.end && k.start < e.end);
    if (!overlaps) kept.push(e);
  }
  return kept.sort((a, b) => a.start - b.start);
}

module.exports = {
  REGEX_RECOGNIZERS,
  regexEntities,
  resolveOverlaps,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node functions/rag/anonymize.test.js`
Expected: all `ok` lines, `7 passed, 0 failed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add functions/rag/anonymize.js functions/rag/anonymize.test.js
git commit -m "$(cat <<'EOF'
feat: add regex PII recognizers and overlap resolution

First layer of the anonymization tool: domain regex recognizers
(FIR/case number, dates, phone) and a sorted-sweep overlap resolver
that keeps the higher-scoring entity on a span conflict.
EOF
)"
```

---

### Task 2: NER integration, consistent anonymization, reveal

**Files:**
- Modify: `functions/rag/anonymize.js`
- Modify: `functions/rag/anonymize.test.js`

**Interfaces:**
- Consumes: `REGEX_RECOGNIZERS`, `regexEntities`, `resolveOverlaps` from Task 1 (unchanged signatures).
- Produces: `nerEntities(text: string, nerFn: (docs: string[]) => Promise<Array<{ner:{general_entities: Array<{start_index:number, end_index:number, confidence_score:string|number, ner_tag:string, token:string}>}}>>) => Promise<{entities: Array<Entity>, available: boolean}>`
- Produces: `anonymizeText(text: string, entities: Array<Entity>) => {anonymizedText: string, entityMap: {[type: string]: {[originalText: string]: string}}, entityCounts: {[type: string]: number}}`
- Produces: `revealText(text: string, entityMap: {[type: string]: {[originalText: string]: string}}) => string`
- Produces: `detectAndAnonymize(text: string, nerFn: Function) => Promise<{anonymizedText: string, entityMap: object, entityCounts: object, nerAvailable: boolean}>` — the single entry point Task 3's handler calls.

**Resolves spec open risk #1** (whether Zia's `end_index` is inclusive/exclusive is undocumented): `nerEntities` never uses `end_index`. It derives the end offset from `start_index + token.length` and only keeps the entity if that exact slice of the source text equals `token` — an offset that doesn't line up with its own token is dropped rather than risking a bad splice into identity text.

- [ ] **Step 1: Write the failing test**

Append to `functions/rag/anonymize.test.js`, **before** the final `console.log`/`process.exit` lines:

```js
// ── Consistent placeholders ─────────────────────────────────────────────────
{
  const text = 'Ravi Kumar met Ravi Kumar near Chennai.';
  const first = span(text, 'Ravi Kumar');
  const second = span(text, 'Ravi Kumar', first.end);
  const loc = span(text, 'Chennai');
  const entities = [
    { type: 'PERSON', ...first, score: 1 },
    { type: 'PERSON', ...second, score: 1 },
    { type: 'LOCATION', ...loc, score: 1 },
  ];
  const { anonymizedText, entityMap, entityCounts } = anonymize.anonymizeText(text, entities);
  check('the same value gets the same placeholder',
    anonymizedText === 'PERSON_0 met PERSON_0 near LOCATION_0.');
  check('entityMap records the mapping for reveal', entityMap.PERSON['Ravi Kumar'] === 'PERSON_0');
  check('entityCounts reflects distinct values per type',
    entityCounts.PERSON === 1 && entityCounts.LOCATION === 1);
}

// ── Reveal roundtrip ─────────────────────────────────────────────────────────
{
  const text = 'Ravi Kumar met Suresh near Chennai.';
  const entities = [
    { type: 'PERSON', ...span(text, 'Ravi Kumar'), score: 1 },
    { type: 'PERSON', ...span(text, 'Suresh'), score: 1 },
    { type: 'LOCATION', ...span(text, 'Chennai'), score: 1 },
  ];
  const { anonymizedText, entityMap } = anonymize.anonymizeText(text, entities);
  check('reveal reproduces the original text exactly',
    anonymize.revealText(anonymizedText, entityMap) === text);

  const thirdPartyReport = `Case summary: ${anonymizedText} Filed under review.`;
  const revealedReport = anonymize.revealText(thirdPartyReport, entityMap);
  check('reveal also works on a third-party document built from the anonymized text',
    revealedReport === `Case summary: ${text} Filed under review.`);
}

// ── NER integration (injectable — no live Zia call) ─────────────────────────
{
  (async () => {
    const text = 'John works at Zoho in Chennai';
    const johnSpan = span(text, 'John');
    const chennaiSpan = span(text, 'Chennai');
    const zohoSpan = span(text, 'Zoho');
    const fakeNer = async () => [{
      ner: { general_entities: [
        { start_index: johnSpan.start, end_index: johnSpan.end - 1, confidence_score: '0.95', ner_tag: 'PERSON', token: 'John' },
        { start_index: chennaiSpan.start, end_index: chennaiSpan.end - 1, confidence_score: '0.9', ner_tag: 'LOCATION', token: 'Chennai' },
        // Deliberately wrong offset (does not point at its own token) — must
        // be dropped, not spliced in and corrupt the text.
        { start_index: zohoSpan.start + 1, end_index: zohoSpan.end, confidence_score: '0.4', ner_tag: 'ORG', token: 'Zoho' },
      ] },
    }];
    const { entities, available } = await anonymize.nerEntities(text, fakeNer);
    check('NER wrapper is available when the injected call succeeds', available === true);
    check('a correctly-offset entity is kept',
      entities.some((e) => e.text === 'John' && e.type === 'PERSON'));
    check('a mis-offset entity is dropped rather than corrupting a later splice',
      !entities.some((e) => e.text === 'Zoho'));

    const failingNer = async () => { throw new Error('quota exceeded'); };
    const degraded = await anonymize.nerEntities(text, failingNer);
    check('a failing NER call degrades to unavailable rather than throwing',
      degraded.available === false && degraded.entities.length === 0);

    const mergeText = 'FIR 9/2026 says John met Chennai.';
    const mergeJohn = span(mergeText, 'John');
    const full = await anonymize.detectAndAnonymize(mergeText, async () => [{
      ner: { general_entities: [
        { start_index: mergeJohn.start, end_index: mergeJohn.end - 1, confidence_score: '0.95', ner_tag: 'PERSON', token: 'John' },
      ] },
    }]);
    check('detectAndAnonymize merges regex and NER hits',
      full.anonymizedText === 'FIR FIR_NUMBER_0 says PERSON_0 met Chennai.');
    check('detectAndAnonymize reports NER availability', full.nerAvailable === true);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}
```

Then **delete** the old, now-duplicate `console.log`/`process.exit` pair that used to be at the end of the file (the synchronous checks above run before this new async block resolves, so the final summary/exit must be the one inside it).

- [ ] **Step 2: Run test to verify it fails**

Run: `node functions/rag/anonymize.test.js`
Expected: `TypeError: anonymize.anonymizeText is not a function` (not implemented yet).

- [ ] **Step 3: Write the implementation**

Append to `functions/rag/anonymize.js`, replacing the `module.exports` block:

```js
// Zia's NER response shape (functions/rag/node_modules/zcatalyst-sdk-node/
// lib/utils/pojo/zia.d.ts, ICatalystZiaNer): one array of {start_index,
// end_index, confidence_score, ner_tag, token} per input document. end_index's
// inclusive/exclusive convention isn't documented, so it is never used here —
// the end offset is derived from the token's own length instead, and an
// entity is kept only if that exact slice matches the token.
async function nerEntities(text, nerFn) {
  if (!text.trim()) return { entities: [], available: true };
  let resp;
  try {
    resp = await nerFn([text]);
  } catch {
    return { entities: [], available: false };
  }
  const general = (resp && resp[0] && resp[0].ner && resp[0].ner.general_entities) || [];
  const entities = [];
  for (const e of general) {
    const token = String(e.token || '');
    const start = Number(e.start_index);
    if (!token || !Number.isInteger(start) || start < 0) continue;
    const end = start + token.length;
    if (text.slice(start, end) !== token) continue; // offset doesn't match its own token — drop it
    entities.push({
      type: String(e.ner_tag || 'ENTITY').toUpperCase(),
      start, end, text: token,
      score: Number(e.confidence_score) || 0.5,
    });
  }
  return { entities, available: true };
}

// Consistent instance-counter anonymizer: the same (type, value) pair always
// gets the same placeholder within this call. Placeholders are assigned in
// first-appearance order, then spliced back-to-front so earlier offsets stay
// valid while later ones are replaced.
function anonymizeText(text, entities) {
  const byStart = [...entities].sort((a, b) => a.start - b.start);
  const map = {};
  const counts = {};
  for (const e of byStart) {
    const bucket = map[e.type] || (map[e.type] = {});
    if (!bucket[e.text]) {
      const idx = counts[e.type] || 0;
      bucket[e.text] = `${e.type}_${idx}`;
      counts[e.type] = idx + 1;
    }
  }
  let out = text;
  for (const e of [...byStart].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + map[e.type][e.text] + out.slice(e.end);
  }
  const entityCounts = Object.fromEntries(
    Object.entries(map).map(([type, bucket]) => [type, Object.keys(bucket).length])
  );
  return { anonymizedText: out, entityMap: map, entityCounts };
}

// Replaces every placeholder found in `text` with its original value. Works
// even when `text` isn't the anonymized output verbatim but a report or
// third-party document built from it — that's the point of keeping the map
// server-side rather than baking a one-shot substitution into the response.
function revealText(text, entityMap) {
  let out = String(text || '');
  for (const bucket of Object.values(entityMap || {})) {
    for (const [original, placeholder] of Object.entries(bucket)) {
      out = out.split(placeholder).join(original);
    }
  }
  return out;
}

async function detectAndAnonymize(text, nerFn) {
  const regexHits = regexEntities(text);
  const { entities: nerHits, available } = await nerEntities(text, nerFn);
  const merged = resolveOverlaps([...regexHits, ...nerHits]);
  const { anonymizedText, entityMap, entityCounts } = anonymizeText(text, merged);
  return { anonymizedText, entityMap, entityCounts, nerAvailable: available };
}

module.exports = {
  REGEX_RECOGNIZERS,
  regexEntities,
  resolveOverlaps,
  nerEntities,
  anonymizeText,
  revealText,
  detectAndAnonymize,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node functions/rag/anonymize.test.js`
Expected: all `ok` lines, `16 passed, 0 failed`, exit code 0.

- [ ] **Step 5: Run the full backend suite**

Run: `cd functions/rag && npm test`
Expected: every suite prints `ok` lines only and the process exits 0 — no regression in `apigate.test.js`, `redaction.test.js`, etc.

- [ ] **Step 6: Commit**

```bash
git add functions/rag/anonymize.js functions/rag/anonymize.test.js
git commit -m "$(cat <<'EOF'
feat: add Zia NER integration, consistent anonymization, reveal

detectAndAnonymize is the module's single entry point: merges regex
and NER hits, assigns consistent per-call placeholders, and returns
the reversible entity map. NER offsets are verified against the
token itself rather than trusted, since Zia's end_index convention
isn't documented.
EOF
)"
```

---

### Task 3: Wire into the router — routes, handler, clearance gate, audit

**Files:**
- Modify: `functions/rag/index.js`

**Interfaces:**
- Consumes: `anonymize.detectAndAnonymize(text, nerFn)`, `anonymize.revealText(text, entityMap)` (Task 2).
- Consumes existing helpers already in `index.js`/`redaction.js`: `readBody(req)`, `json(res, status, obj)`, `catalystSDK.initialize(req)`, `app.stratus().bucket(CONV_BUCKET)`, `app.zia().getNERPrediction(docs)`, `myRole(app, bucket) => {role, caller}`, `streamToString(stream)`, `storeAuditEvents(req, app, bucket, events, sessionUser)`, `redaction.clearanceOf(role)`, `redaction.PROTECTED_CLEARANCE`.
- Produces: routes `POST .../anonymize/text` and `POST .../anonymize/reveal`, dispatched via `handleAnonymize(req, res, action)`.

- [ ] **Step 1: Add the require**

In `functions/rag/index.js`, immediately after the existing `const redaction = require('./redaction');` (line 5):

```js
const anonymize = require('./anonymize');
```

- [ ] **Step 2: Add `handleAnonymize`**

Add this function near the other simple two-verb handlers (e.g. right before or after `handleAccess`, around line 2483):

```js
// POST .../anonymize/text    { text }              -> { mapId, anonymizedText, entityCounts, nerAvailable }
// POST .../anonymize/reveal  { mapId, text }        -> { text }
// Text is capped the same way handleSupport caps its message field — this is
// pasted casework text, not a file upload.
async function handleAnonymize(req, res, action) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);

  if (action === 'anonymize') {
    const text = String(body.text || '').slice(0, 20000);
    if (!text.trim()) return json(res, 400, { error: 'text is required' });

    const result = await anonymize.detectAndAnonymize(
      text,
      (docs) => app.zia().getNERPrediction(docs)
    );

    const mapId = `anon_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    await bucket.putObject(
      `anonymize/maps/${mapId}.json`,
      Buffer.from(JSON.stringify({
        owner: String(caller?.email_id || '').toLowerCase(),
        createdAt: Date.now(),
        entityMap: result.entityMap,
      }))
    );

    return json(res, 200, {
      mapId,
      anonymizedText: result.anonymizedText,
      entityCounts: result.entityCounts,
      nerAvailable: result.nerAvailable,
    });
  }

  if (action === 'reveal') {
    const mapId = String(body.mapId || '');
    const text = String(body.text || '').slice(0, 20000);
    if (!mapId || !text.trim()) return json(res, 400, { error: 'mapId and text are required' });

    if (redaction.clearanceOf(role) < redaction.PROTECTED_CLEARANCE) {
      await storeAuditEvents(req, app, bucket, [{
        action: 'anonymize-reveal-denied', feature: 'Anonymize', path: '/anonymize',
        detail: `mapId=${mapId} role=${role}`,
      }], caller);
      return json(res, 403, { error: 'Insufficient clearance to reveal identities' });
    }

    let stored;
    try {
      stored = JSON.parse(await streamToString(await bucket.getObject(`anonymize/maps/${mapId}.json`)));
    } catch {
      return json(res, 404, { error: 'Unknown mapId' });
    }

    const revealed = anonymize.revealText(text, stored.entityMap);

    await storeAuditEvents(req, app, bucket, [{
      action: 'anonymize-reveal', feature: 'Anonymize', path: '/anonymize',
      detail: `mapId=${mapId}`,
    }], caller);

    return json(res, 200, { text: revealed });
  }

  return json(res, 400, { error: 'unknown action' });
}
```

- [ ] **Step 3: Register the routes**

In the router dispatch block, next to the other similarly-shaped routes (near `if (path.endsWith('/support'))` around line 5298):

```js
if (path.endsWith('/anonymize/text')) return await handleAnonymize(req, res, 'anonymize');
if (path.endsWith('/anonymize/reveal')) return await handleAnonymize(req, res, 'reveal');
```

- [ ] **Step 4: Meter both routes**

In `functions/rag/index.js`, change the `METERED_ROUTES` regex (line 2199) from:

```js
const METERED_ROUTES = /\/(transcribe|report-pdf|vision\/parse|reportdocs\/ai|investigation\/summarize|investigation\/ocr|predict\/[a-z]+|forecast(\/refresh)?|digitise\/(upload|ingest)|financial\/narrative|sanctions\/batch|patrol\/directions|sherlock\/start)$/;
```

to:

```js
const METERED_ROUTES = /\/(transcribe|report-pdf|vision\/parse|reportdocs\/ai|investigation\/summarize|investigation\/ocr|predict\/[a-z]+|forecast(\/refresh)?|digitise\/(upload|ingest)|financial\/narrative|sanctions\/batch|patrol\/directions|sherlock\/start|anonymize\/(text|reveal))$/;
```

- [ ] **Step 5: Run the backend test suite**

Run: `cd functions/rag && npm test`
Expected: every suite passes, including `apigate.test.js` (both new routes are dispatched after the session gate — the test counts `path.endsWith(` occurrences generically, so no test-file change is needed for a new route to be covered).

- [ ] **Step 6: Commit**

```bash
git add functions/rag/index.js
git commit -m "$(cat <<'EOF'
feat: wire anonymize routes into the rag function router

POST .../anonymize/text and .../anonymize/reveal, both metered.
Reveal is gated by the existing PROTECTED_CLEARANCE tier and logs to
the audit trail on both grant and denial. The reversible entity map
lives in Stratus under anonymize/maps/<id>.json and is never returned
to the caller — only the mapId.
EOF
)"
```

*(End-to-end verification of this wiring — an actual signed-in POST against a live `catalyst serve` — happens in Task 6, once the frontend page exists to drive it through a real session. A bare `curl` here would only prove the session gate rejects an anonymous request, which `apigate.test.js` already covers.)*

---

### Task 4: Frontend API client

**Files:**
- Create: `frontend/src/utils/anonymize.js`

**Interfaces:**
- Produces: `anonymizeText(text: string) => Promise<{mapId: string, anonymizedText: string, entityCounts: object, nerAvailable: boolean}>`
- Produces: `revealText(mapId: string, text: string) => Promise<string>`

- [ ] **Step 1: Write the client**

Create `frontend/src/utils/anonymize.js`:

```js
// Client for the PII anonymization tool (functions/rag/anonymize.js +
// index.js's handleAnonymize). Mirrors the post() pattern already used by
// utils/reportStudio.js.
async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const anonymizeText = (text) => post('/server/rag/anonymize/text', { text });
export const revealText = (mapId, text) =>
  post('/server/rag/anonymize/reveal', { mapId, text }).then((d) => d.text);
```

No dedicated unit test for this file: it's a two-function fetch wrapper with no branch or loop, and `frontend/src/__smoke__/apipaths.test.js` (already existing, runs automatically) checks every `utils/*.js` file for exactly the mistake that would matter here — a relative instead of absolute API path. Functional correctness is verified end-to-end in Task 6.

- [ ] **Step 2: Confirm the existing path-safety check still passes**

Run: `cd frontend && CI=true npx jest src/__smoke__/apipaths.test.js --watchAll=false`
Expected: both tests in that file pass — the new file's two `post('/server/rag/...', ...)` calls use absolute paths.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/utils/anonymize.js
git commit -m "feat: add frontend API client for the anonymize tool"
```

---

### Task 5: Frontend page and wiring

**Files:**
- Create: `frontend/src/pages/Anonymize.js`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/utils/access.js`
- Modify: `frontend/src/components/Sidebar.js`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `anonymizeText`, `revealText` from `frontend/src/utils/anonymize.js` (Task 4).
- Consumes: `useAccess()` from `frontend/src/context/AccessContext.js` (existing) for `role`.

- [ ] **Step 1: Add the route guard entry**

In `frontend/src/utils/access.js`, add to the `FEATURES` array (after the `help` entry):

```js
  { key: 'anonymize', label: 'Anonymize', path: '/anonymize', roles: ALL },
```

- [ ] **Step 2: Write the page**

Create `frontend/src/pages/Anonymize.js`:

```jsx
import React, { useState } from 'react';
import { ShieldOff, Copy, Check, AlertTriangle, EyeOff } from 'lucide-react';
import TopBar from '../components/TopBar';
import { useAccess } from '../context/AccessContext';
import { anonymizeText, revealText } from '../utils/anonymize';

// Mirrors redaction.js's PROTECTED_CLEARANCE tier (functions/rag/redaction.js
// ROLE_CLEARANCE: admin/supervisor/investigator = 3) for UI purposes only —
// the server re-checks clearance on every /anonymize/reveal call regardless.
const CAN_REVEAL = new Set(['admin', 'supervisor', 'investigator']);

export default function Anonymize() {
  const { role } = useAccess();
  const [input, setInput] = useState('');
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState({ state: 'idle', error: null });
  const [copied, setCopied] = useState(false);

  const [revealInput, setRevealInput] = useState('');
  const [revealOutput, setRevealOutput] = useState('');
  const [revealStatus, setRevealStatus] = useState({ state: 'idle', error: null });

  const runAnonymize = async () => {
    if (!input.trim()) return;
    setStatus({ state: 'sending', error: null });
    setResult(null);
    try {
      const data = await anonymizeText(input);
      setResult(data);
      setRevealInput(data.anonymizedText);
      setRevealOutput('');
      setStatus({ state: 'idle', error: null });
    } catch (err) {
      setStatus({ state: 'idle', error: err.message });
    }
  };

  const copyResult = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.anonymizedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the browser; the text is still
      // visible and selectable in the textarea, so this is non-fatal.
    }
  };

  const runReveal = async () => {
    if (!result?.mapId || !revealInput.trim()) return;
    setRevealStatus({ state: 'sending', error: null });
    try {
      const text = await revealText(result.mapId, revealInput);
      setRevealOutput(text);
      setRevealStatus({ state: 'idle', error: null });
    } catch (err) {
      setRevealStatus({ state: 'idle', error: err.message });
    }
  };

  return (
    <div className="cf-page">
      <TopBar title="Anonymize" />
      <div className="pp-body">
        <div className="an-layout">
          <div className="an-intro">
            <div className="an-badge"><ShieldOff size={22} /></div>
            <h1>Anonymize</h1>
            <p className="an-lead">
              Paste an FIR narrative, chargesheet excerpt, or statement. Names, places,
              dates and identifiers are replaced with consistent placeholders — the same
              person or place always gets the same placeholder, so the result stays
              useful for pattern and link analysis.
            </p>
          </div>

          <div className="an-card">
            <label className="an-field">
              <span>Text to anonymize</span>
              <textarea
                className="an-input an-textarea"
                rows={8}
                placeholder="Paste text here…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            </label>

            {status.error && (
              <div className="aa-error"><AlertTriangle size={16} /> {status.error}</div>
            )}

            <button
              type="button"
              className="an-submit"
              disabled={status.state === 'sending' || !input.trim()}
              onClick={runAnonymize}
            >
              {status.state === 'sending' ? 'Anonymizing…' : 'Anonymize'}
            </button>

            {result && (
              <div className="an-result">
                <div className="an-result-head">
                  <span>Anonymized text</span>
                  <button type="button" className="an-copy" onClick={copyResult}>
                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <textarea className="an-input an-textarea" rows={8} readOnly value={result.anonymizedText} />
                <div className="an-counts">
                  {Object.entries(result.entityCounts || {}).map(([type, count]) => (
                    <span className="an-badge-chip" key={type}>{type}: {count}</span>
                  ))}
                  {!result.nerAvailable && (
                    <span className="an-badge-chip an-badge-warn">
                      Name/place detection degraded — only structured identifiers were removed
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {result && CAN_REVEAL.has(role) && (
            <div className="an-card">
              <div className="an-field">
                <span><EyeOff size={14} /> Reveal identities</span>
                <p className="an-lead an-lead-small">
                  Paste the anonymized text back — including any report built from it — and
                  the original names, places and identifiers are restored.
                </p>
              </div>
              <label className="an-field">
                <span>Text to reveal</span>
                <textarea
                  className="an-input an-textarea"
                  rows={6}
                  value={revealInput}
                  onChange={(e) => setRevealInput(e.target.value)}
                />
              </label>

              {revealStatus.error && (
                <div className="aa-error"><AlertTriangle size={16} /> {revealStatus.error}</div>
              )}

              <button
                type="button"
                className="an-submit"
                disabled={revealStatus.state === 'sending' || !revealInput.trim()}
                onClick={runReveal}
              >
                {revealStatus.state === 'sending' ? 'Revealing…' : 'Reveal'}
              </button>

              {revealOutput && (
                <textarea className="an-input an-textarea" rows={6} readOnly value={revealOutput} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Register the route**

In `frontend/src/App.tsx`, add the import near the other page imports (after `import HelpCenter from './pages/HelpCenter';`):

```js
import Anonymize from './pages/Anonymize';
```

Add the route near the other `guarded(...)` routes (after the `/help` route):

```jsx
                <Route path="/anonymize" element={guarded('anonymize', <Anonymize />)} />
```

- [ ] **Step 4: Add the sidebar entry**

In `frontend/src/components/Sidebar.js`, add `ShieldOff` to the `lucide-react` import list (alongside `Headset`):

```js
  Home, AlertTriangle, Map, Brain, Database,
  MessageSquare, Users, ChevronRight, Sun, Moon, LogOut,
  UserCircle, PanelLeftClose, ShieldCheck, NotebookPen, Headset, Building2, CalendarClock,
  ScrollText, Images, ChevronsUpDown, ShieldOff } from 'lucide-react';
```

Add a menu item in the profile dropdown, right after the "Help center" button (same place, same pattern — this is a general utility, not a case-work module, so it belongs with "View profile" / "Help center" rather than the main module nav):

```jsx
                <button className="sb-menu-item" onClick={() => { setMenuOpen(false); navigate('/anonymize'); setMobileOpen(false); }}>
                  <ShieldOff size={16} /> Anonymize
                </button>
```

- [ ] **Step 5: Add styles**

In `frontend/src/index.css`, append after the existing `.hc-success` / Help Center block (after the `@media (max-width: 820px) { .hc-layout {...} }` rule, before the `/* ── Custody & Corrections ── */` comment):

```css
/* ── Anonymize ── */
.an-layout { display: flex; flex-direction: column; gap: 20px; max-width: 720px; }
.an-intro { padding-top: 8px; }
.an-badge {
  display: inline-flex; align-items: center; justify-content: center;
  width: 46px; height: 46px; border-radius: 12px;
  background: var(--blue-glow); color: var(--blue-500); margin-bottom: 16px;
}
.an-intro h1 { font-size: 28px; font-weight: 600; color: var(--text-0); margin: 0 0 10px; letter-spacing: -0.02em; }
.an-lead { font-size: 14px; line-height: 1.6; color: var(--text-3); margin: 0; }
.an-lead-small { font-size: 12.5px; margin-top: 4px; }

.an-card {
  border: 1px solid var(--border); border-radius: 16px; background: var(--bg-1);
  padding: 26px; display: flex; flex-direction: column; gap: 16px;
}
.an-field { display: flex; flex-direction: column; gap: 9px; }
.an-field > span { font-size: 13.5px; font-weight: 500; color: var(--text-1); display: flex; align-items: center; gap: 6px; }
.an-input {
  width: 100%; padding: 12px 14px; line-height: 1.6;
  border: 1px solid var(--border-bright); border-radius: 12px;
  background: var(--bg-2); color: var(--text-0); font-size: 14px; resize: vertical;
}
.an-input:focus { outline: none; border-color: var(--blue-500); background: var(--bg-1); }
.an-input[readonly] { color: var(--text-2); }
.an-submit {
  align-self: flex-start;
  display: inline-flex; align-items: center; justify-content: center; gap: 9px;
  height: 42px; padding: 0 20px; border: none; border-radius: 10px;
  background: var(--blue-500); color: #fff; font-size: 14px; font-weight: 500; cursor: pointer;
}
.an-submit:hover:not(:disabled) { background: var(--primary-hover); }
.an-submit:disabled { opacity: 0.5; cursor: default; }

.an-result { display: flex; flex-direction: column; gap: 10px; }
.an-result-head { display: flex; align-items: center; justify-content: space-between; font-size: 13.5px; font-weight: 500; color: var(--text-1); }
.an-copy {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border-bright); border-radius: 8px; background: var(--bg-1);
  color: var(--text-2); font-size: 12.5px; padding: 5px 10px; cursor: pointer;
}
.an-copy:hover { border-color: var(--blue-500); color: var(--text-0); }

.an-counts { display: flex; flex-wrap: wrap; gap: 8px; }
.an-badge-chip {
  display: inline-block; padding: 3px 10px; border-radius: 9999px;
  background: var(--bg-3); color: var(--text-2); font-size: 11.5px; font-weight: 500;
}
.an-badge-warn { background: color-mix(in srgb, var(--gold) 16%, transparent); color: var(--gold); }
```

- [ ] **Step 6: Lint and test**

Run: `cd frontend && npx eslint src --ext .js --ignore-pattern '__smoke__'`
Expected: no errors.

Run: `cd frontend && CI=true npm test -- --watchAll=false`
Expected: all suites pass, including `i18n.test.js` (untouched — no new translation keys added) and `apipaths.test.js`.

- [ ] **Step 7: Build**

Run: `cd frontend && npm install --legacy-peer-deps && npm run build` (only if `node_modules` isn't already installed; otherwise just `npm run build`)
Expected: build succeeds, `build/404.html` exists (the `postbuild` copy).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Anonymize.js frontend/src/App.tsx frontend/src/utils/access.js frontend/src/components/Sidebar.js frontend/src/index.css
git commit -m "$(cat <<'EOF'
feat: add the Anonymize page

Reachable from the profile dropdown (same place as Help center) since
it's a general utility, not a case-work module. Every role can
anonymize; only admin/supervisor/investigator see the reveal panel,
matching the server's PROTECTED_CLEARANCE gate on /anonymize/reveal.
EOF
)"
```

---

### Task 6: End-to-end verification in the browser

**Files:** none (verification only).

- [ ] **Step 1: Serve locally**

Run:
```bash
PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH" catalyst serve --http 3000
```
Expected: log output shows the `rag` function served (not "skipping serve of function [rag]") and the client at `/app/`.

- [ ] **Step 2: Sign in**

Open `http://localhost:3000/app` in a browser and sign in (local serve has no session by default — authenticated paths sit at "Checking access…" until this is done, per `CLAUDE.md`).

- [ ] **Step 3: Anonymize, as any role**

From the profile menu (bottom of the sidebar), open "Anonymize". Paste text containing a repeated name, a place, and an FIR-style number, e.g.:

```
Ravi Kumar filed FIR 42/2026 on 04/03/2026 after a theft near Majestic, Bengaluru. Ravi Kumar was later contacted at 9876543210.
```

Click **Anonymize**. Confirm:
- The result textarea shows the text with names/places/identifiers replaced by `TYPE_N` placeholders.
- "Ravi Kumar" maps to the same placeholder both times it appears.
- Entity-type count chips are shown (e.g. `PERSON: 1`, `FIR_NUMBER: 1`, `DATE: 1`, `PHONE: 1`).
- **Copy** puts the anonymized text on the clipboard.

- [ ] **Step 4: Reveal, gated by role**

If signed in as `investigator`/`supervisor`/`admin`: confirm the **Reveal identities** panel is visible, paste the anonymized text (pre-filled) into it, click **Reveal**, and confirm the output textarea reproduces the *original* pasted text exactly.

If signed in as `analyst`/`policymaker` (use the Access & Audit page to change the signed-in test account's role, or a second test account): confirm the **Reveal identities** panel does **not** appear at all after anonymizing.

- [ ] **Step 5: Confirm server-side enforcement, not just UI hiding**

While signed in as a role below `PROTECTED_CLEARANCE` (`analyst`/`policymaker`), use the browser devtools console to call the endpoint directly and confirm the server rejects it independent of the UI:

```js
fetch('/server/rag/anonymize/reveal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mapId: 'anon_test', text: 'PERSON_0' }),
}).then((r) => r.status).then(console.log);
```

Expected: `403`.

- [ ] **Step 6: Confirm the audit trail recorded the reveal**

As `admin`, open **Access & Audit** and confirm an `anonymize-reveal` (and, from Step 5, `anonymize-reveal-denied`) entry appears for the relevant accounts.

- [ ] **Step 7: Report the result**

No commit for this task — it's verification of Tasks 1-5's already-committed work. If any check above fails, fix the relevant task's code, re-run that task's automated tests, redo this task's browser walkthrough, and commit the fix before considering the plan complete.

---

## Self-Review Notes

- **Spec coverage:** Purpose (Task 5/6 page), regex + Zia NER detection (Task 1/2), overlap resolution (Task 1), consistent placeholders (Task 2), reversibility + clearance gate + audit (Task 2/3), error handling — Zia failure degrades gracefully (Task 2 `nerEntities`), empty text / unknown mapId / clearance denial (Task 3), frontend (Task 5), testing (Task 1/2/4/5) — all covered. The spec's "Open items" #1 (Zia response shape) is resolved in Task 2 via the token-length + slice-match approach; #2 (audit call shape) is resolved by reusing `storeAuditEvents` as already used elsewhere in `index.js`; #3 (frontend route/nav placement) is resolved in Task 5 (profile dropdown, not main nav).
- **No placeholders:** every step above has literal code or literal shell commands with expected output; nothing says "add validation" or "TBD".
- **Type consistency:** `Entity` shape (`{type, start, end, text, score}`) is used identically across `regexEntities`, `resolveOverlaps`, `nerEntities`, and `anonymizeText`. `entityMap` shape (`{[type]: {[original]: placeholder}}`) is identical across `anonymizeText`, `revealText`, and the Stratus-stored record in Task 3. `anonymizeText`/`revealText`/`detectAndAnonymize` names match between Task 2's module and Task 3's `handleAnonymize` calls, and between Task 4's client and Task 5's page.
