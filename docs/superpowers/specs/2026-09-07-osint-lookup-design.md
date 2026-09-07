# OSINT lookup — design spec

## Why

Sentinel's assistant and analytics are entirely introspective: every lane
(ZCQL, RAG, the tool loop) answers from data already inside the platform.
There is no way for an officer to ask "what do we know about this IP" or
"who registered this domain" and get an answer grounded in anything outside
Sentinel's own Data Store and Stratus buckets. This closes that gap for the
two identifier types that are cheap and legally uncomplicated to look up —
IP addresses and domains — without touching the country's data-sovereignty
posture the codebase has already committed to (see `utils/publicRefs.js`'s
header comment: "police content does not leave the country," with the
Groq lane as the one documented, bounded exception).

## What this is

A new tool in the assistant's existing tool-calling loop, `osint_lookup`,
alongside `query_records`, `traverse_network`, `lookup_law`, etc. There is
no new page, no new route in the React Router tree, no sidebar entry. The
officer reaches this purely by asking the assistant something like "check
IP 45.33.12.9" or "who owns example-domain.com" — the model decides to call
the tool the same way it already decides to call `traverse_network`.

## Scope (v1)

In scope:
- IP address lookup: RDAP (registration) + AbuseIPDB (reputation, optional
  key).
- Domain lookup: RDAP (registration) only.

Explicitly out of scope for v1 (not forgotten — deferred):
- Phone/email breach-checking (HaveIBeenPwned's API is now paid).
- Shodan (paid key).
- Cross-referencing a hit against Sentinel's own case text — this needs a
  full-text search over investigation-diary/digitised-OCR content that does
  not exist anywhere in the app yet. That is a second project, not a line
  item on this one.

## Architecture

### New module: `functions/rag/osint.js`

Same shape as `legal.js` / `network.js` — a self-contained module the tools
registry requires. Exports:

```
lookup({ kind, value }) -> Promise<result>
```

- `kind`: `'ip' | 'domain'`. Anything else is a caller error, not a network
  call.
- `value`: validated by regex before any fetch — a plausible IPv4/IPv6
  address for `kind:'ip'`, a plausible hostname for `kind:'domain'`. An
  invalid value returns `{ error }` with no network call, mirroring
  `queryRecords`'s validate-before-call shape.
- Two external calls, run with `Promise.allSettled` so one failing does not
  take down the other:
  - **RDAP** — `https://rdap.org/ip/<value>` or `https://rdap.org/domain/<value>`.
    Free, keyless. `AbortSignal.timeout` matching the codebase's existing
    external-call timeouts (12s, same as the ORS leg timeout).
  - **AbuseIPDB** (`kind:'ip'` only) — `https://api.abuseipdb.com/api/v2/check`,
    header `Key: process.env.ABUSEIPDB_API_KEY`. The key is optional: with
    none configured, or on any AbuseIPDB failure, that panel reports
    `available:false` and RDAP's result still returns — exactly the
    `handlePatrolDirections` / `ORS_API_KEY` pattern (fail soft, never let
    a missing key or a downed third party take out the whole feature).
- Return shape carries a `sovereignty` note the tool definition instructs
  the model to always surface in its answer (same technique `lookup_law`
  uses for its `DISCLAIMER` field): this identifier was sent to rdap.org /
  api.abuseipdb.com, outside Sentinel and outside India.

### Tool registration: `functions/rag/tools.js`

- New `DEFINITIONS` entry, `osint_lookup`, `input_schema: { kind: enum,
  value: string }`, both required. Description states plainly that this
  reaches external services outside India, so the model knows to disclose
  it — not left to be discovered from the result payload.
- New `case 'osint_lookup'` in `run()`'s dispatch `switch`. Role gate
  inline, exactly like `case_obligations`:
  ```
  if (!['admin', 'supervisor', 'investigator', 'analyst'].includes(role)) {
    return { error: 'OSINT lookups are limited to investigators, supervisors, analysts and admin.' };
  }
  ```
  No `policymaker` — this is operational tooling, not an oversight view.
- No redaction pass: the result describes a public IP/domain's registration
  and reputation, not a person or a case record — there is nothing in it
  redaction.js's clearance filter has a rule for.
- No new citation/`rowSets`/`scanHits` wiring: `query_records` is the only
  tool today that contributes to citations, and this tool doesn't carry
  Data Store rows. It still lands in the per-turn audit trail for free —
  `runToolLoop`'s `used` array already records every tool call by name
  (`osint_lookup` or `osint_lookup:error` on failure), which is what feeds
  `validatorChecks.push(\`tools:${looped.used.join(',')}\`)`. That existing
  mechanism is the whole audit story here; nothing new needs to be built
  for it.
- No fencing change needed: every tool result already passes through the
  single `guard.fence` choke point in `runToolLoop` regardless of which
  tool produced it, so a hostile RDAP/AbuseIPDB response (an attacker
  controls what THEIR own server reports about THEIR own IP) is contained
  the same way a hostile scanned document already is.

## Error handling

- Invalid `kind`/`value`: `{ error }`, no network call — same shape as
  `query_records`' validator rejection, which the model can read and
  correct.
- RDAP down/no data: that section of the result is `null`/`available:false`;
  domain lookup with nothing from RDAP returns `{ found: false }` rather
  than an error, since "no registration data" is itself an answer.
- AbuseIPDB down or unkeyed: `available:false` for that section only, RDAP
  section unaffected.
- Role gate failure: `{ error }` returned to the model as an ordinary tool
  result (same as every other gated tool here) — the loop does not throw,
  it lets the model explain to the officer that this lookup needs different
  clearance.

## Testing

`functions/rag/osint.test.js`, following the house `check()` pattern (no
framework, plain node script, picked up automatically by `npm test`):

- Format validation rejects malformed IP/domain values without a network
  call.
- A mocked fetch failing one source and succeeding the other proves
  fail-soft independence (RDAP down + AbuseIPDB up still returns AbuseIPDB
  data, and vice versa).
- The role gate is exercised by reading `tools.js` as text and evaluating
  the real `run()`/dispatch fragment via `new Function`, matching how
  `case_obligations`' gate and other dispatch-level guards are tested
  elsewhere in this suite — not a regex match on source text.

## Explicitly not built

- No frontend page, route, sidebar entry, `access.js` FEATURES entry, or
  i18n strings. This tool has no UI of its own.
- No new audit-logging code path — the existing `used`-array mechanism
  covers it.
- No redaction-filter changes.
