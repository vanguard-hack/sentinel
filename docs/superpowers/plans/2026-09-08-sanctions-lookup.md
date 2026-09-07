# Sanctions/Watchlist Lookup Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the assistant's tool loop a `sanctions_check` tool that screens a name against the UN Security Council Consolidated List, refreshed roughly daily from a cached local index rather than fetched live per question.

**Architecture:** `functions/rag/sanctions.js` is a pure module (fetch the UN's XML, parse it, text-match a query against a given index) with zero Stratus/Catalyst dependency of its own — exactly the separation `forecast.js` already draws between building a fresh bundle and caching it. `index.js`'s `runToolLoop` owns the actual Stratus cache read/write, the same way `handleForecast` already does for the forecast bundle, and injects a `sanctionsCheck` closure into the tool deps the same way `caseObligations` and `digitisedSearch` already are. `functions/rag/tools.js` gets a new `DEFINITIONS` entry and dispatch `case` consuming that closure, with an inline role gate matching `osint_lookup`'s. `functions/rag/sources.js` gets a `fromSanctions()` citation function reusing the existing `EXTERNAL_WEB` type.

**Tech Stack:** Node.js (CommonJS), the platform's built-in global `fetch`, the existing Stratus bucket API (`bucket.getObject`/`bucket.putObject`, already used by `handleForecast`), no test framework — the house `check()`-based `*.test.js` convention.

**Spec:** `docs/superpowers/specs/2026-09-08-sanctions-lookup-design.md`

## Global Constraints

- Source: `https://unsolprodfiles.blob.core.windows.net/publiclegacyxmlfiles/EN/consolidated.xml` — verified directly, real schema, 736 `<INDIVIDUAL>` + 275 `<ENTITY>` records.
- Every fetch carries a `User-Agent` header (`Sentinel-Sanctions/1.0 (Karnataka State Police crime platform)`) — the source's edge blocks requests without one, verified directly the same way `osint.js` had to work around rdap.org.
- Cache key: `sanctions/index-v1.json` in the `CONV_BUCKET` Stratus bucket (same bucket `handleForecast` already uses). Staleness threshold: 24 hours (`STALE_MS`).
- Roles allowed to call the tool: `admin`, `supervisor`, `investigator`, `analyst` — no `policymaker`, matching `osint_lookup`.
- Matching is plain normalized token matching — every query token must appear in the candidate's name or an alias. Not fuzzy, not phonetic; the tool description says so explicitly.
- Results capped to `MAX_MATCHES = 10`.
- No frontend changes, no new route in `index.js`'s router, no new audit-logging code, no redaction-filter changes, no automatic screening pass in Financial Trails or Crime Links — all explicitly out of scope per the spec.

---

### Task 1: `sanctions.js` — fetch, parse, match

**Files:**
- Create: `functions/rag/sanctions.js`
- Test: `functions/rag/sanctions.test.js`

**Interfaces:**
- Produces: `sanctions.fetchXml() -> Promise<string>` (raises on a non-OK response).
- Produces: `sanctions.parseIndex(xml: string) -> Array<Record>` where `Record = { kind: 'individual'|'entity', dataId, name, aliases: string[], referenceNumber, listType, listedOn, comments, designation: string[] }`.
- Produces: `sanctions.buildIndex() -> Promise<{ records: Record[], fetchedAt: number }>` (fetch + parse in one call).
- Produces: `sanctions.search(records: Record[], query: string) -> { found: boolean, matches: Array<Record & { matchedOn: string }>, total: number }`.
- Produces constants: `sanctions.CACHE_KEY` (string), `sanctions.STALE_MS` (number), `sanctions.MAX_MATCHES` (number, 10).
- Consumes: nothing from other tasks — self-contained.

- [ ] **Step 1: Write the failing test file**

Create `functions/rag/sanctions.test.js`:

```js
// Sanctions/watchlist lookup: XML parsing against a fixture (not the live
// 2.5MB file, so this suite runs offline and fast) and text matching.
// Run: node functions/rag/sanctions.test.js

const sanctions = require('./sanctions');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// A fixture in the REAL schema, verified directly against the live file
// before this was written (see the design spec) — not guessed at.
const FIXTURE_XML = `<?xml version='1.0' encoding='UTF-8'?>
<CONSOLIDATED_LIST xmlns:xsi='http://www.w3.org/2001/XMLSchema-instance' xsi:noNamespaceSchemaLocation='https://www.un.org/sc/resources/sc-sanctions.xsd' dateGenerated='2026-09-05T23:00:04.811Z'>
    <INDIVIDUALS>
        <INDIVIDUAL>
            <DATAID>110404</DATAID>
            <VERSIONNUM>1</VERSIONNUM>
            <FIRST_NAME>MOHAMMAD BAQER</FIRST_NAME>
            <SECOND_NAME>ZOLQADR</SECOND_NAME>
            <UN_LIST_TYPE>Iran</UN_LIST_TYPE>
            <REFERENCE_NUMBER>IRi.043</REFERENCE_NUMBER>
            <LISTED_ON>2007-03-24</LISTED_ON>
            <COMMENTS1>[Old Reference # I.47.D.7]</COMMENTS1>
            <HAS_INTERPOL_LINK>NO</HAS_INTERPOL_LINK>
            <INTERPOL_LINK/>
            <DESIGNATION>
                <VALUE>General</VALUE>
                <VALUE>IRGC officer</VALUE>
            </DESIGNATION>
            <LIST_TYPE>
                <VALUE>UN List</VALUE>
            </LIST_TYPE>
            <INDIVIDUAL_ALIAS>
                <QUALITY>Good</QUALITY>
                <ALIAS_NAME>Mohammad Bakr Zolqadr</ALIAS_NAME>
            </INDIVIDUAL_ALIAS>
            <INDIVIDUAL_ADDRESS>
                <COUNTRY/>
            </INDIVIDUAL_ADDRESS>
        </INDIVIDUAL>
        <INDIVIDUAL>
            <DATAID>110405</DATAID>
            <FIRST_NAME>MOHAMMAD REZA</FIRST_NAME>
            <SECOND_NAME>ZAHEDI</SECOND_NAME>
            <UN_LIST_TYPE>Iran</UN_LIST_TYPE>
            <REFERENCE_NUMBER>IRi.042</REFERENCE_NUMBER>
            <LISTED_ON>2007-03-24</LISTED_ON>
            <COMMENTS1></COMMENTS1>
            <DESIGNATION>
                <VALUE>Brigadier General</VALUE>
            </DESIGNATION>
        </INDIVIDUAL>
    </INDIVIDUALS>
    <ENTITIES>
        <ENTITY>
            <DATAID>110326</DATAID>
            <FIRST_NAME>YAZD METALLURGY INDUSTRIES (YMI)</FIRST_NAME>
            <UN_LIST_TYPE>Iran</UN_LIST_TYPE>
            <REFERENCE_NUMBER>IRe.078</REFERENCE_NUMBER>
            <LISTED_ON>2010-06-09</LISTED_ON>
            <COMMENTS1>YMI is a subordinate of DIO. [Old Reference #E.29.I.22].</COMMENTS1>
            <ENTITY_ALIAS>
                <QUALITY>a.k.a.</QUALITY>
                <ALIAS_NAME>Yazd Ammunition Manufacturing and Metallurgy Industries</ALIAS_NAME>
            </ENTITY_ALIAS>
        </ENTITY>
    </ENTITIES>
</CONSOLIDATED_LIST>`;

const records = sanctions.parseIndex(FIXTURE_XML);

// ── Parsing ─────────────────────────────────────────────────────────────
check('every fixture record is parsed', records.length === 3);
check("an individual's name is FIRST_NAME + SECOND_NAME",
  records[0].name === 'MOHAMMAD BAQER ZOLQADR');
check('an individual is tagged by kind', records[0].kind === 'individual');
check('an entity is tagged by kind', records.find((r) => r.dataId === '110326').kind === 'entity');
check('the reference number is captured', records[0].referenceNumber === 'IRi.043');
check('the listing date is captured', records[0].listedOn === '2007-03-24');
check('aliases are captured', records[0].aliases.includes('Mohammad Bakr Zolqadr'));
check('a record with no alias still parses with an empty list',
  Array.isArray(records[1].aliases) && records[1].aliases.length === 0);
check('repeated DESIGNATION values are all captured',
  records[0].designation.includes('General') && records[0].designation.includes('IRGC officer'));
check('designation does not pick up unrelated VALUE tags from LIST_TYPE',
  !records[0].designation.includes('UN List'));
check("an entity's single-name field is still read as \"name\"",
  records.find((r) => r.dataId === '110326').name === 'YAZD METALLURGY INDUSTRIES (YMI)');
check("an entity's own alias tag is read, not the individual one",
  records.find((r) => r.dataId === '110326').aliases
    .includes('Yazd Ammunition Manufacturing and Metallurgy Industries'));

// ── Matching ────────────────────────────────────────────────────────────
check('an exact name match is found',
  sanctions.search(records, 'Mohammad Baqer Zolqadr').found);
check('matching is case-insensitive',
  sanctions.search(records, 'mohammad baqer zolqadr').found);
check('punctuation in the query does not defeat the match',
  sanctions.search(records, 'Yazd Metallurgy Industries (YMI)').found);
check('a match on the primary name is labelled as such',
  sanctions.search(records, 'Zolqadr').matches[0].matchedOn === 'name');
check('a match found only in an alias is labelled with that alias',
  /alias: Mohammad Bakr Zolqadr/.test(
    sanctions.search(records, 'Mohammad Bakr Zolqadr').matches[0].matchedOn));
check('word order does not matter, since every query token must simply appear',
  sanctions.search(records, 'Zolqadr Mohammad').found);
check('a name that is not in the list is a clean no-match',
  sanctions.search(records, 'Some Unrelated Person').found === false);
check('an empty query is refused rather than matching everything',
  sanctions.search(records, '').found === false);
check('the cap constant is 10', sanctions.MAX_MATCHES === 10);
check('the true count is reported even when results are capped',
  typeof sanctions.search(records, 'Iran').total === 'number');

// ── Fetch (mocked) ──────────────────────────────────────────────────────
const originalFetch = global.fetch;

(async () => {
  let sawUserAgent = false;
  global.fetch = async (url, opts) => {
    sawUserAgent = !!(opts && opts.headers && opts.headers['User-Agent']);
    return { ok: true, text: async () => FIXTURE_XML };
  };
  const built = await sanctions.buildIndex();
  check('the fetch carries a distinguishing User-Agent', sawUserAgent);
  check('buildIndex fetches and parses in one call', built.records.length === 3);
  check('buildIndex stamps when it ran', typeof built.fetchedAt === 'number' && built.fetchedAt > 0);

  global.fetch = async () => ({ ok: false, status: 403 });
  let threw = false;
  try { await sanctions.buildIndex(); } catch { threw = true; }
  check('a failed fetch throws rather than silently returning an empty index', threw);

  global.fetch = originalFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node functions/rag/sanctions.test.js`
Expected: `Error: Cannot find module './sanctions'` — the module does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `functions/rag/sanctions.js`:

```js
'use strict';

// Sanctions/watchlist lookup — the UN Security Council Consolidated List,
// text-matched against a name an officer is checking. Unlike osint.js, this
// is NOT a live per-query call: the source changes once a day, not once a
// question, so a 2.5MB fetch-and-parse on every assistant turn would spend
// real time out of the tool budget for no reason. This module deliberately
// knows nothing about Stratus or caching — index.js's runToolLoop owns the
// cache read/write, the same separation forecast.js already draws between
// building a fresh bundle and handleForecast caching it. A pure function is
// easier to test and to reason about than one that also knows where its own
// cache lives.
//
// Source verified directly against the live file before any of this was
// written: https://unsolprodfiles.blob.core.windows.net/publiclegacyxmlfiles/EN/consolidated.xml
// — 2.5MB, updated daily, 736 <INDIVIDUAL> + 275 <ENTITY> records under one
// <CONSOLIDATED_LIST> root. Its edge blocks requests with no distinguishing
// User-Agent, the same way rdap.org does, so every fetch here carries one.

const SOURCE_URL = 'https://unsolprodfiles.blob.core.windows.net/publiclegacyxmlfiles/EN/consolidated.xml';
const USER_AGENT = 'Sentinel-Sanctions/1.0 (Karnataka State Police crime platform)';
const FETCH_TIMEOUT_MS = 20_000;

// The index is rebuilt once it is older than this. The source itself
// updates daily; checking more often would only ever re-fetch the same
// file.
const STALE_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = 'sanctions/index-v1.json';
const MAX_MATCHES = 10;

// ── Fetch ────────────────────────────────────────────────────────────────

async function fetchXml() {
  const res = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`sanctions list fetch failed: HTTP ${res.status}`);
  return res.text();
}

// ── Parse ────────────────────────────────────────────────────────────────
//
// A hand-rolled, deliberately narrow parser rather than a full XML library:
// the real schema (verified directly against the live file) is flat enough
// that pulling out the handful of fields this tool needs is a handful of
// regexes, not a DOM. Anything the schema adds later that this does not
// read is simply not surfaced — never guessed at.

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// The first (and for these tags, only) match of <TAG>...</TAG> in a block.
function textOf(block, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
  return m ? decodeEntities(m[1].trim()) : '';
}

// Same, but the raw inner text is returned unescaped — used to scope a
// search to inside one sub-element (e.g. DESIGNATION) before pulling its
// own repeated children, so a sibling element's same-named children (e.g.
// LIST_TYPE's own <VALUE>) are never picked up by accident.
function subBlock(block, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
  return m ? m[1] : '';
}

// Every match of <TAG>...</TAG> in a block, in order.
function allOf(block, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(decodeEntities(m[1].trim()));
  return out;
}

function aliasesOf(block, wrapTag) {
  const re = new RegExp(`<${wrapTag}>([\\s\\S]*?)<\\/${wrapTag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(block))) {
    const name = textOf(m[1], 'ALIAS_NAME');
    if (name) out.push(name);
  }
  return out;
}

function parseRecord(block, kind) {
  const first = textOf(block, 'FIRST_NAME');
  const second = textOf(block, 'SECOND_NAME');
  const third = textOf(block, 'THIRD_NAME');
  const name = [first, second, third].filter(Boolean).join(' ');
  const aliasTag = kind === 'individual' ? 'INDIVIDUAL_ALIAS' : 'ENTITY_ALIAS';
  // Scoped to inside <DESIGNATION> specifically — the same block also
  // contains <LIST_TYPE><VALUE>UN List</VALUE></LIST_TYPE>, and a bare
  // allOf(block, 'VALUE') over the WHOLE record would silently fold that
  // in as if it were a designation.
  const designation = allOf(subBlock(block, 'DESIGNATION'), 'VALUE')
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 6);
  return {
    kind,
    dataId: textOf(block, 'DATAID'),
    name,
    aliases: aliasesOf(block, aliasTag),
    referenceNumber: textOf(block, 'REFERENCE_NUMBER'),
    listType: textOf(block, 'UN_LIST_TYPE'),
    listedOn: textOf(block, 'LISTED_ON'),
    comments: textOf(block, 'COMMENTS1'),
    designation,
  };
}

function blocksOf(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/**
 * Parse the Consolidated List's raw XML into a flat, search-ready index.
 * A record missing an optional field still gets indexed on what it has.
 */
function parseIndex(xml) {
  const individuals = blocksOf(xml, 'INDIVIDUAL').map((b) => parseRecord(b, 'individual'));
  const entities = blocksOf(xml, 'ENTITY').map((b) => parseRecord(b, 'entity'));
  return [...individuals, ...entities].filter((r) => r.name);
}

/** Fetch and parse in one call — the unit index.js's cache layer rebuilds. */
async function buildIndex() {
  const xml = await fetchXml();
  const records = parseIndex(xml);
  return { records, fetchedAt: Date.now() };
}

// ── Match ────────────────────────────────────────────────────────────────

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '') // strip diacritics
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Text-match a query against a built index's records. Every query token
 * must appear somewhere in a candidate's name or one of its aliases — not
 * fuzzy, not phonetic, and the tool built on this says so plainly. A hit
 * means the text matched, nothing more; every result carries what it
 * matched on so an officer can judge it themselves.
 */
function search(records, query) {
  const qTokens = normalize(query).split(' ').filter(Boolean);
  if (!qTokens.length) return { found: false, matches: [], total: 0 };
  const hits = [];
  for (const r of records) {
    const nameNorm = normalize(r.name);
    if (qTokens.every((t) => nameNorm.includes(t))) {
      hits.push({ ...r, matchedOn: 'name' });
      continue;
    }
    const aliasHit = r.aliases.find((a) => {
      const an = normalize(a);
      return qTokens.every((t) => an.includes(t));
    });
    if (aliasHit) {
      hits.push({ ...r, matchedOn: `alias: ${aliasHit}` });
      continue;
    }
    const combined = normalize([r.name, ...r.aliases].join(' '));
    if (qTokens.every((t) => combined.includes(t))) {
      hits.push({ ...r, matchedOn: 'name and aliases combined' });
    }
  }
  return { found: hits.length > 0, matches: hits.slice(0, MAX_MATCHES), total: hits.length };
}

module.exports = {
  SOURCE_URL,
  CACHE_KEY,
  STALE_MS,
  MAX_MATCHES,
  fetchXml,
  parseIndex,
  buildIndex,
  normalize,
  search,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node functions/rag/sanctions.test.js`
Expected: every `check(...)` prints `ok`, final line reports `0 failed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add functions/rag/sanctions.js functions/rag/sanctions.test.js
git commit -m "$(cat <<'EOF'
feat(sanctions): add UN Consolidated List fetch/parse/match module

Standalone module, not yet wired into the assistant. Deliberately
Stratus-agnostic — fetch, parse and text-match only — following the
same separation forecast.js already draws between building a bundle
and caching it. Source and schema verified directly against the live
2.5MB XML file before writing any code against it.
EOF
)"
```

---

### Task 2: `sources.js` — `fromSanctions()` citations

**Files:**
- Modify: `functions/rag/sources.js`
- Modify: `functions/rag/sources.test.js`

**Interfaces:**
- Consumes: nothing at runtime from Task 1 directly — takes plain objects shaped like `sanctions.search()`'s `matches` entries (`{ kind, dataId, name, aliases, referenceNumber, listType, listedOn, comments, designation, matchedOn }`), but has no `require('./sanctions')` of its own.
- Produces: `attribution.fromSanctions(hits: Array<MatchRecord>) -> Array<Citation>`, exported alongside `fromOsint`. Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

In `functions/rag/sources.test.js`, add after the existing OSINT section (after the `an analyst can see an OSINT citation` check):

```js

// ── Sanctions/watchlist citations ──────────────────────────────────────
const sanctionsHits = [{
  kind: 'entity', dataId: '110326', name: 'YAZD METALLURGY INDUSTRIES (YMI)',
  aliases: ['Yazd Ammunition Manufacturing and Metallurgy Industries'],
  referenceNumber: 'IRe.078', listType: 'Iran', listedOn: '2010-06-09',
  comments: 'YMI is a subordinate of DIO.', designation: [], matchedOn: 'name',
}];
const sanctionsCited = a.fromSanctions(sanctionsHits);
check('a sanctions match produces one citation', sanctionsCited.length === 1);
check('it names the real, checkable UN Consolidated List page',
  sanctionsCited[0].uri === 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list'
  && sanctionsCited[0].domain === 'un.org');
check('it carries the reference number as an identifier',
  sanctionsCited[0].identifier === 'IRe.078');
check('it carries the concrete facts as its passage',
  /Reference: IRe\.078/.test(sanctionsCited[0].passages[0].excerpt)
  && /Listed on: 2010-06-09/.test(sanctionsCited[0].passages[0].excerpt));
check('no hits produces no citations', a.fromSanctions([]).length === 0);
check('an analyst can see a sanctions citation — it names a public UN record, not a case',
  a.clearanceFilter(a.merge(sanctionsCited), 'analyst').sources.length === 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node functions/rag/sources.test.js`
Expected: `TypeError: a.fromSanctions is not a function`.

- [ ] **Step 3: Write the implementation**

In `functions/rag/sources.js`, add after `fromOsint` and before `// ── Clearance ──`:

```js
// ── Lane 7: sanctions/watchlist screening ───────────────────────────────
//
// No stable per-record URL exists on the UN's site to deep-link a single
// entry, so every citation points at the Consolidated List's own resource
// page and carries the reference number and DATAID as identifiers instead
// — the same shape fromZcql already uses for matched_record_ids rather
// than a URL per row.

const SANCTIONS_LIST_URL = 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list';

function fromSanctions(hits) {
  return (Array.isArray(hits) ? hits : []).map((h) => {
    const facts = [
      h.listType ? `UN list type: ${h.listType}` : null,
      h.referenceNumber ? `Reference: ${h.referenceNumber}` : null,
      h.listedOn ? `Listed on: ${h.listedOn}` : null,
      (h.designation || []).length ? `Designation: ${h.designation.join(', ')}` : null,
      h.comments ? `Comments: ${h.comments}` : null,
      h.matchedOn ? `Matched on: ${h.matchedOn}` : null,
    ].filter(Boolean).join(' · ');
    return {
      source_type: TYPES.EXTERNAL_WEB,
      display_name: `UN Sanctions List — ${str(h.name, 160)}`,
      uri: SANCTIONS_LIST_URL,
      domain: 'un.org',
      scope: 'UN Security Council Consolidated List',
      identifier: str(h.referenceNumber, 60) || null,
      passages: facts ? [{ location: null, excerpt: str(facts, 800), score: null }] : [],
    };
  });
}
```

And add `fromSanctions` to the `module.exports` block:

```js
  fromZcql,
  fromVision,
  fromWeb,
  fromOsint,
  fromSanctions,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node functions/rag/sources.test.js`
Expected: every `check(...)` prints `ok`, final line reports `0 failed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add functions/rag/sources.js functions/rag/sources.test.js
git commit -m "$(cat <<'EOF'
feat(sanctions): add fromSanctions() citation function

Reuses the existing EXTERNAL_WEB citation type (already fully wired
in the frontend, no UI changes needed). Links to the UN Consolidated
List's own resource page — no stable per-record URL exists on their
site — and carries the reference number as an identifier, the same
shape fromZcql already uses for record ids without a URL per row.
EOF
)"
```

---

### Task 3: Wire the Stratus-cached lookup and citations into `index.js`

**Files:**
- Modify: `functions/rag/index.js`
- Modify: `functions/rag/tools.test.js` (loop-contract section only — role-gate tests come in Task 4)

**Interfaces:**
- Consumes: `sanctions.CACHE_KEY`, `sanctions.STALE_MS`, `sanctions.buildIndex()`, `sanctions.search(records, query)` from Task 1; `attribution.fromSanctions(hits)` from Task 2.
- Produces: a `sanctionsCheck` closure in `runToolLoop`'s `deps` object with signature `async (query: string) -> { found, matches, total, indexAgeMs } | { error }`. Task 4's dispatch case consumes this exact shape.
- Produces: `runToolLoop`'s return value gains a `sanctionsHits` array (flat list of matched records). Nothing outside this task and the `TOOLS` route handler reads it directly.

- [ ] **Step 1: Write the failing tests**

In `functions/rag/tools.test.js`, find this existing block (added when `osint_lookup` was wired in):

```js
  check('an osint_lookup result is collected for citations, the same way query_records rows are',
    /c\.name === 'osint_lookup'[\s\S]{0,80}osintHits\.push\(out\)/.test(loop));
  check('osintHits travels out of the loop in its return value',
    /return \{ text, used, rowSets, scanHits, osintHits,/.test(loop));
```

Add immediately after it:

```js
  check('a sanctions_check result is collected for citations',
    /c\.name === 'sanctions_check'[\s\S]{0,160}sanctionsHits\.push/.test(loop));
  check('sanctionsHits travels out of the loop in its return value',
    /return \{ text, used, rowSets, scanHits, osintHits, sanctionsHits,/.test(loop));
  check('the sanctions cache is checked for staleness before rebuilding',
    /Date\.now\(\) - cached\.fetchedAt < sanctions\.STALE_MS/.test(loop));
  check('a failed rebuild falls back to the stale cache rather than failing outright',
    /stale && Array\.isArray\(stale\.records\)/.test(loop));
  check('a successful rebuild is written back to the cache',
    /bucket\.putObject\(sanctions\.CACHE_KEY/.test(loop));
```

Then find this existing block (also from `osint_lookup`'s wiring):

```js
  check('every Data Store result the loop read becomes a citation',
    /for \(const set of looped\.rowSets\)/.test(route));
  check('every OSINT lookup the loop read becomes a citation too',
    /for \(const hit of looped\.osintHits\)/.test(route));
  check('  built by the same fromOsint attribution function sources.js exports',
    /attribution\.fromOsint\(hit\)/.test(route));
```

Add immediately after it (before the `knowledge-base fallback` check that follows):

```js
  check('every sanctions match the loop found becomes a citation too',
    /looped\.sanctionsHits\.length/.test(route));
  check('  built by the same fromSanctions attribution function sources.js exports',
    /attribution\.fromSanctions\(looped\.sanctionsHits\)/.test(route));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node functions/rag/tools.test.js`
Expected: the five new `loop`-section checks and two new `route`-section checks all print `FAIL` (the source text they look for does not exist yet); everything else still passes.

- [ ] **Step 3: Write the implementation**

In `functions/rag/index.js`, add the require near the top, alongside the other sibling-module requires (find `const attribution = require('./sources');` and add after it):

```js
const attribution = require('./sources');
const sanctions = require('./sanctions');
```

In `runToolLoop`, find:

```js
  const rowSets = [];    // Data Store rows, for citations
  const scanHits = [];   // digitised records, for citations
  const osintHits = [];  // RDAP/AbuseIPDB lookups, for citations
```

Add after it:

```js
  const sanctionsHits = []; // UN sanctions-list matches, for citations
```

Find the `deps` object's opening (`const deps = {`) and, inside it, add a new `sanctionsCheck` entry — placed after `caseObligations` (the last existing entry), before the closing `};`:

```js
    // Cache-backed, not a live call per question: the source updates once
    // a day, so a 2.5MB fetch-and-parse on every turn would waste the tool
    // budget on data that has not changed. Same shape handleForecast
    // already uses for the forecast bundle — check the cache, rebuild if
    // stale or missing, fall back to a stale cache on a failed rebuild
    // rather than failing the tool outright.
    sanctionsCheck: async (query) => {
      let index;
      try {
        const cached = JSON.parse((await streamToString(await bucket.getObject(sanctions.CACHE_KEY))) || 'null');
        if (cached && Array.isArray(cached.records) && Date.now() - cached.fetchedAt < sanctions.STALE_MS) {
          index = cached;
        }
      } catch { /* no cache yet — fall through and build one */ }
      if (!index) {
        try {
          const built = await sanctions.buildIndex();
          index = built;
          try {
            await bucket.putObject(sanctions.CACHE_KEY, Buffer.from(JSON.stringify(built), 'utf8'));
          } catch (e) {
            console.error('sanctions cache write failed (non-fatal):', e && e.message);
          }
        } catch (e) {
          try {
            const stale = JSON.parse((await streamToString(await bucket.getObject(sanctions.CACHE_KEY))) || 'null');
            if (stale && Array.isArray(stale.records)) index = stale;
          } catch { /* nothing cached at all */ }
          if (!index) return { error: `Sanctions list unavailable: ${(e && e.message) || e}` };
        }
      }
      const result = sanctions.search(index.records, query);
      return { ...result, indexAgeMs: Date.now() - index.fetchedAt };
    },
```

Find the tool-result processing block:

```js
          if (c.name === 'query_records' && out && Array.isArray(out.rows) && out.rows.length) {
            rowSets.push({ rows: out.rows, query: (c.input && c.input.zcql) || '' });
          }
          if (c.name === 'osint_lookup' && out && !out.error && (out.rdap || out.abuseipdb)) {
            osintHits.push(out);
          }
```

Add after it:

```js
          if (c.name === 'sanctions_check' && out && !out.error && Array.isArray(out.matches) && out.matches.length) {
            sanctionsHits.push(...out.matches);
          }
```

Find the return statement:

```js
        return { text, used, rowSets, scanHits, osintHits, usedKnowledgeBase, protectedAccess, toolThreats, iterations: i + 1 };
```

Replace with:

```js
        return { text, used, rowSets, scanHits, osintHits, sanctionsHits, usedKnowledgeBase, protectedAccess, toolThreats, iterations: i + 1 };
```

In the `TOOLS` route handler, find:

```js
          for (const hit of looped.osintHits) cites.push(attribution.fromOsint(hit));
          // The knowledge-base fallback is only worth showing when nothing else
```

Insert the sanctions citation line between them:

```js
          for (const hit of looped.osintHits) cites.push(attribution.fromOsint(hit));
          if (looped.sanctionsHits.length) cites.push(attribution.fromSanctions(looped.sanctionsHits));
          // The knowledge-base fallback is only worth showing when nothing else
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node functions/rag/tools.test.js`
Expected: every `check(...)` prints `ok`, `0 failed`.

Also re-run Task 1 and Task 2's suites to confirm nothing regressed: `node functions/rag/sanctions.test.js` and `node functions/rag/sources.test.js` — both expected unchanged, `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add functions/rag/index.js functions/rag/tools.test.js
git commit -m "$(cat <<'EOF'
feat(sanctions): wire the cached lookup and citations into runToolLoop

sanctionsCheck is injected into the tool loop's deps the same way
caseObligations and digitisedSearch already are — index.js owns the
Stratus cache read/write (check staleness, rebuild if stale or
missing, fall back to a stale cache on a failed rebuild) the same way
handleForecast already caches the forecast bundle. sanctions.js itself
stays Stratus-agnostic. Matches produce real citations via
attribution.fromSanctions, wired the same way osintHits/fromOsint
already are.
EOF
)"
```

---

### Task 4: Register `sanctions_check` in `tools.js`

**Files:**
- Modify: `functions/rag/tools.js`
- Modify: `functions/rag/tools.test.js`

**Interfaces:**
- Consumes: the `sanctionsCheck` deps closure from Task 3, signature `async (query: string) -> { found, matches, total, indexAgeMs } | { error }`.
- Produces: `sanctions_check` reachable via `tools.run('sanctions_check', { query }, deps)`. Nothing else depends on this task.

- [ ] **Step 1: Write the failing tests**

In `functions/rag/tools.test.js`, find the OSINT block's opening checks:

```js
  check('the OSINT tool discloses that the lookup leaves Sentinel and India',
    /outside Sentinel and outside India/.test(
      tools.DEFINITIONS.find((d) => d.name === 'osint_lookup').description));
```

...through to the end of that block (the last line is `check('an uncleared caller cannot reach OSINT lookups either', ...)`), then insert this new block immediately after it, before the `// ── case_obligations ──` or next section:

```js

  // ── sanctions_check ──────────────────────────────────────────────────
  //
  // Text matching, not identity verification — the tool has to say so, and
  // it has to be the ONLY tool the model reaches for on a sanctions
  // question, the same disambiguation osint_lookup needed after a real bug
  // where the model fell back to search_knowledge_base instead.

  check('the sanctions tool discloses that it is text matching, not identity verification',
    /not verified identity/.test(
      tools.DEFINITIONS.find((d) => d.name === 'sanctions_check').description));
  check('the sanctions tool tells the model it is the ONLY source for watchlist data',
    /ONLY tool that knows anything about international sanctions/.test(
      tools.DEFINITIONS.find((d) => d.name === 'sanctions_check').description));
  check('the knowledge-base tool also rules out sanctions questions',
    /sanctions_check/.test(
      tools.DEFINITIONS.find((d) => d.name === 'search_knowledge_base').description));

  const fakeSanctionsCheck = async () => ({ found: false, matches: [], total: 0 });
  for (const role of ['investigator', 'supervisor', 'admin', 'analyst']) {
    const ok = await run('sanctions_check', { query: 'Test Name' },
      { role, sanctionsCheck: fakeSanctionsCheck });
    check(`${role} can reach the sanctions check (gate passes)`, ok.found === false);
  }
  const sanctionsDenied = await run('sanctions_check', { query: 'Test Name' },
    { role: 'policymaker', sanctionsCheck: fakeSanctionsCheck });
  check('policymaker cannot reach sanctions checks through the assistant',
    /limited to investigators, supervisors, analysts and admin/.test(sanctionsDenied.error || ''));
  const sanctionsNoRole = await run('sanctions_check', { query: 'Test Name' },
    { sanctionsCheck: fakeSanctionsCheck });
  check('an uncleared caller cannot reach sanctions checks either',
    /limited to investigators, supervisors, analysts and admin/.test(sanctionsNoRole.error || ''));

  check('with no sanctions index available the tool says so instead of throwing',
    /unavailable/i.test(
      (await run('sanctions_check', { query: 'x' }, { role: 'investigator' })).error || ''));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node functions/rag/tools.test.js`
Expected: crashes with `TypeError: Cannot read properties of undefined (reading 'description')` on the first new check (`sanctions_check` is not in `DEFINITIONS` yet).

- [ ] **Step 3: Write the implementation**

In `functions/rag/tools.js`, extend `search_knowledge_base`'s description (find the text ending `'Do not call this tool as a fallback for a question that names an IP or domain.',`) and change it to also rule out sanctions questions:

```js
      'Search the written knowledge base — BNSS and IPC procedure, standing orders, ' +
      'investigation practice, departmental circulars. Use this for "how do I", "what ' +
      'does the law require", "what is the procedure for". It holds no case records; ' +
      'use query_records for those. It holds nothing about IP addresses, domains or ' +
      'any other external/internet identifier either — use osint_lookup for those. ' +
      'It holds nothing about sanctions or watchlists either — use sanctions_check for ' +
      'those. Do not call this tool as a fallback for a question that names an IP, a ' +
      'domain, or asks about a sanctions listing.',
```

Add a new `DEFINITIONS` entry after `osint_lookup`'s (as the new last element of the array, before the closing `];`):

```js
  {
    name: 'sanctions_check',
    description:
      'Check a name — a person or an organisation — against the UN Security ' +
      'Council Consolidated List of sanctioned individuals and entities. Use ' +
      'this when an officer asks whether a name is on a sanctions or ' +
      'watchlist, or when a name surfacing in a financial or network ' +
      'investigation is worth screening. This is the ONLY tool that knows ' +
      'anything about international sanctions listings — never call ' +
      'search_knowledge_base or query_records for this instead; neither ' +
      'holds this data.\n\n' +
      'This is text matching against a name, not verified identity — a hit ' +
      'means the name matched, nothing more, and must be reported to the ' +
      'officer as a lead to verify, never as a confirmed identification. ' +
      'The list is refreshed roughly daily from the UN\'s own published ' +
      'source; this does not send the officer\'s question anywhere — the ' +
      'lookup runs against a copy already held by Sentinel.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The person or organisation name to check.',
        },
      },
      required: ['query'],
    },
  },
```

In `run()`'s destructure of `deps` (find `const { app, role, ragSearch, digitisedSearch, access, caseObligations } = deps;`), add `sanctionsCheck`:

```js
  const { app, role, ragSearch, digitisedSearch, access, caseObligations, sanctionsCheck } = deps;
```

Add a new `case` after `case 'osint_lookup':`'s closing brace, before `default:`:

```js
      case 'sanctions_check': {
        // Same gate as osint_lookup: checked inline at dispatch so a new
        // tool cannot forget it.
        if (!['admin', 'supervisor', 'investigator', 'analyst'].includes(role)) {
          return { error: 'Sanctions checks are limited to investigators, supervisors, analysts and admin.' };
        }
        if (typeof sanctionsCheck !== 'function') return { error: 'Sanctions list unavailable.' };
        return await sanctionsCheck((input && input.query) || '');
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node functions/rag/tools.test.js`
Expected: every `check(...)` prints `ok`, `0 failed`.

Then run the full backend suite to confirm nothing anywhere regressed: `cd functions/rag && npm test` — expected every suite reports `0 failed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add functions/rag/tools.js functions/rag/tools.test.js
git commit -m "$(cat <<'EOF'
feat(sanctions): register sanctions_check as an assistant tool

Ninth tool alongside osint_lookup and the rest. Role gate matches
osint_lookup's (admin/supervisor/investigator/analyst, no
policymaker). search_knowledge_base's description now also rules out
sanctions questions, learned from the earlier osint_lookup
disambiguation bug rather than waiting to hit it again.
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** "Data source" verification → embedded in Task 1's module comment and fixture, taken directly from the spec's documented schema. "Fetch strategy: cached index" → Task 3 in full (staleness check, rebuild, stale-fallback, cache write). "Matching" → Task 1's `search()`. "Tool registration" → Task 4. "Citations" → Task 2 + the wiring half in Task 3. "Error handling" → each case (blank query, index build failure with/without a prior cache, no match) has a specific test: Task 1's fetch-failure-throws test, Task 3's stale-fallback and cache-miss-unavailable checks, Task 4's no-sanctions-index-available check. "Explicitly not built" needs no task — it is exactly what this plan does not touch.
- **Placeholder scan:** none — every step carries complete, runnable code.
- **Type consistency:** `sanctionsCheck(query: string) -> { found, matches, total, indexAgeMs } | { error }` is identical across Task 3's implementation and Task 4's dispatch call and test fakes. `sanctions.search()`'s return shape (`{ found, matches, total }`, each match carrying `matchedOn`) is identical across Task 1's implementation, Task 1's tests, Task 3's `sanctionsHits.push(...out.matches)`, and Task 2's `fromSanctions` fixture shape.
