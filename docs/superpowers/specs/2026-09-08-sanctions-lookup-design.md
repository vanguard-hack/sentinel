# Sanctions/watchlist lookup — design spec

## Why

Every one of Sentinel's assistant lanes and tools answers from data already
inside the platform, except `osint_lookup` (IP/domain reputation), which
was the first to look outward at all. This closes a second, related gap:
an officer investigating a case — especially in Financial Trails, where
shell companies and mule accounts already surface as suspicious — has no
way to ask "is this name on a sanctions list" and get a real answer. The
UN Security Council Consolidated List is exactly that data, free and
public, and nothing in Sentinel today consults it.

## What this is

A new tool in the assistant's tool-calling loop, alongside `osint_lookup`
and the rest: `sanctions_check`. No new page, no new route in the React
Router tree, no sidebar entry — reached purely by the model deciding to
call it, the same way every tool in `tools.js` already works. Financial
Trails and Crime Links are not touched in v1; wiring an automatic
screening pass into their existing scoring is real future value but is a
second, larger project that depends on this tool's fetch/cache/match
infrastructure existing and being proven first.

## Data source (verified directly, not assumed)

`https://unsolprodfiles.blob.core.windows.net/publiclegacyxmlfiles/EN/consolidated.xml`
— the UN Security Council Consolidated List, fetched and inspected directly
during design:

- Free, keyless, no auth. A normal `User-Agent` header is enough — verified
  the same 403-without-one / 200-with-one behaviour `osint.js` already
  works around for rdap.org, so this reuses that same header.
- ~2.5MB XML, `Last-Modified` confirms same-day updates — this list
  changes daily, not per-second.
- 736 `<INDIVIDUAL>` records + 275 `<ENTITY>` records under one
  `<CONSOLIDATED_LIST dateGenerated="...">` root.
- Individual fields actually present: `DATAID`, `FIRST_NAME`,
  `SECOND_NAME`, `THIRD_NAME` (when present), `UN_LIST_TYPE`,
  `REFERENCE_NUMBER`, `LISTED_ON`, `COMMENTS1`, `DESIGNATION/VALUE`
  (repeated), `INDIVIDUAL_ALIAS/ALIAS_NAME` (repeated, with a `QUALITY`
  rating), `INDIVIDUAL_ADDRESS/COUNTRY`, `INDIVIDUAL_DATE_OF_BIRTH`,
  `INDIVIDUAL_PLACE_OF_BIRTH/CITY,COUNTRY`.
- Entity fields: the same identity/reference fields, `ENTITY_ALIAS`
  (repeated), `ENTITY_ADDRESS` (repeated, with `STREET`/`CITY`/`COUNTRY`).
- No stable per-record URL exists for deep-linking a single entry — the
  citation links to the list resource itself and carries the
  `REFERENCE_NUMBER` and `DATAID` as identifiers, the same way `fromZcql`
  cites `matched_record_ids` rather than a URL per row.

India's own wanted/proclaimed-offender angle (NIA most-wanted) was
checked and ruled out for v1: it is a searchable web page with no API and
no bulk download. Scraping it would repeat the exact fragility problem
that ruled out VAHAN for vehicle lookup — not in scope here either.

## Architecture

### Fetch strategy: cached index, not a live call per question

Unlike `osint_lookup`, this is not a live per-query network call. A 2.5MB
XML parse on every assistant turn would spend real time out of the
45-second `TOOL_BUDGET_MS` for data that only changes once a day. Instead:

- **`functions/rag/sanctions.js`** owns fetching, parsing, and caching.
  `ensureIndex()` checks a Stratus-cached JSON index
  (`sanctions/index-v1.json`, following the exact cache-key-versioning
  precedent `forecast.js`'s `CACHE_KEY` already establishes) for staleness
  — rebuilt if missing or older than 24 hours, matching the source's own
  daily update cadence. A fresh index is used as-is; no network call on
  a normal request.
- The parsed index is small: for each of the ~1,011 records, only the
  fields a match or a citation could need — full name, alias list,
  reference number, DATAID, list type, listed-on date, designation/
  comments, country. Well under the size that would matter for a Stratus
  blob.
- Rebuilding fetches the XML fresh, parses both `<INDIVIDUALS>` and
  `<ENTITIES>` sections, and writes the new index + a `fetchedAt`
  timestamp back to Stratus. If the fetch or parse fails, `ensureIndex()`
  falls back to serving the last good cached index rather than failing
  the tool outright — a day-old sanctions list is still far more useful
  than no answer, and is explicitly labeled with its actual age in the
  result so nothing is presented as more current than it is.
- Because the query never leaves Sentinel's own infrastructure — only the
  periodic background refresh talks to the UN's server — this tool does
  **not** carry `osint_lookup`'s "this leaves India" disclosure. That
  wording would be false here; the honest statement is that the *index*
  is refreshed from an external public source periodically, which is a
  materially different and lesser disclosure.

### Matching

Simple, honestly-labeled text matching — not a sophisticated identity
resolver, and the tool says so:

- Normalize both the query and every candidate name/alias: lowercase,
  strip punctuation and diacritics, collapse whitespace.
- A hit is a normalized substring/token-overlap match against the full
  name (`FIRST_NAME` + `SECOND_NAME` + `THIRD_NAME`) or any alias.
- Ranked matches are returned, capped to the top 10, each carrying enough
  fields for the officer to judge it themselves — never a bare "yes/no."
- Same posture `traverse_network` already takes: "results are
  investigative leads for an officer to verify — being a text match on
  this list means nothing more than that."
- No match is reported as an explicit `found: false`, not an empty result
  the model could read either way.

### Tool registration: `functions/rag/tools.js`

- New `DEFINITIONS` entry, `sanctions_check`, `input_schema: { query:
  string }` (a name — person or organization), required.
- Description states plainly: source is the UN Security Council
  Consolidated List, text-matched (not verified identity), index refreshed
  roughly daily, and — critically, learned from the `osint_lookup`
  disambiguation bug — explicitly rules out being used for anything other
  than sanctions/watchlist screening, and is named as the ONLY tool for
  this so the model does not reach for `search_knowledge_base` or
  `query_records` instead.
- New `case 'sanctions_check'` in `run()`'s dispatch `switch`, role gate
  inline exactly like `osint_lookup` and `case_obligations`:
  `admin`/`supervisor`/`investigator`/`analyst`, no `policymaker`.
- No redaction pass needed: results describe a public UN record, not a
  Sentinel case record or person in the Data Store.
- Lands in the per-turn audit trail for free via the existing `used`
  array mechanism — nothing new to build there, same as `osint_lookup`.

### Citations: `functions/rag/sources.js`

- New `fromSanctions(hits)`, reusing the existing `EXTERNAL_WEB` type
  (already fully wired in the frontend, no UI changes needed) — one
  citation per matched record, `uri` pointing at the UN Security Council's
  Consolidated List page (the general resource, since no stable per-record
  URL exists), `display_name` naming the matched entity/individual, and
  the passage carrying the concrete facts: list type, reference number,
  listed-on date, designation/comments.
- Wired into `runToolLoop`'s citation collection exactly the way
  `osint_lookup`'s `osintHits` already is: a `sanctionsHits` array
  collected in the loop, pushed into `cites` via `attribution
  .fromSanctions(...)` in the `TOOLS` route handler, travelling out of
  `runToolLoop`'s return value the same way.
- A tool call that finds nothing produces no citation — consistent with
  the "no source for a negative answer" rule already agreed for
  `osint_lookup` and still pending as a fix there.

## Error handling

- A blank/missing `query`: `{ error }`, no index build, no network call.
- Index build fails (network down, XML malformed) with no prior good
  cache: `{ error: 'Sanctions list unavailable.' }` — the model can tell
  the officer plainly rather than guessing.
- Index build fails with a prior good cache available: serves the stale
  cache, result carries `indexAge` (or similar) so the tool's own output
  states its own age rather than presenting stale data as current.
- No match: `{ found: false }`, not an empty array left for the model to
  interpret.

## Testing

`functions/rag/sanctions.test.js`, house `check()` pattern:

- XML parsing tested against a small fixture (a handful of hand-written
  `<INDIVIDUAL>`/`<ENTITY>` records in the real schema) rather than the
  live 2.5MB file, so the suite runs offline and fast.
- Matching: exact name, alias match, case/diacritic/punctuation
  insensitivity, no-match returns `found: false`, ranking order for
  multiple hits.
- Cache staleness: a mocked "cached index" object with an old `fetchedAt`
  triggers a rebuild; a fresh one does not (no fetch call made — asserted
  the same way `osint.test.js` asserts "none of the rejections touched
  the network").
- Fetch failure with a stale-but-present cache falls back to it rather
  than erroring; fetch failure with no cache at all errors cleanly.

`functions/rag/tools.test.js` additions, mirroring `osint_lookup`'s own
block: schema declares the source and disambiguates against other tools;
role gate exercised for every role (allowed and denied) the same way;
citation wiring asserted in `runToolLoop`'s source text the same way
`osintHits`/`fromOsint` already are.

## Explicitly not built in v1

- No automatic screening pass in Financial Trails or Crime Links — noted
  as real future value, not scoped here.
- No India-specific wanted-list source (NIA has no public API or bulk
  download — confirmed, not assumed).
- No scheduled/cron refresh job — the lazy, checked-on-call staleness
  pattern already used by `forecast.js` is reused instead; no new
  infrastructure.
- No fuzzy/phonetic matching (Soundex, Levenshtein) — plain normalized
  substring/token matching only, honestly labeled as such.
