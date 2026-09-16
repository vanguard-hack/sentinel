# PII anonymization tool — design spec

Date: 2026-09-16

## Purpose

A general-purpose privacy tool for Sentinel: an officer pastes text (FIR
narrative, chargesheet excerpt, witness statement, or any free text fed in
through the web app) and gets back a version with personal identifiers —
names, places/addresses, dates/times, and domain identifiers like FIR/case
numbers and phone numbers — replaced with consistent placeholders, so
pattern/link analysis on the anonymized text still gives valid results. An
authorized role can reverse a specific anonymization later.

Not in scope for this iteration: batch anonymization of the existing FIR
synthetic dataset generators, image/OCR input, cross-document identity
consistency (the same person getting the same placeholder across two
unrelated paste sessions).

## Inspiration and deviation

Modeled on the entity-detection and anonymization design in
[Saurabhrajput1234/KSP_Project-Sherlock](https://github.com/Saurabhrajput1234/KSP_Project-Sherlock)
(read-only reference, not forked, not reused as code): a Presidio-based
analyzer with custom regex recognizers layered over NER, overlap resolution
between recognizers, and a consistent instance-counter anonymizer
(`<PERSON_0>`, `<PERSON_1>`, ...) with a caller-held entity map for later
de-anonymization.

Sentinel is a single Node.js Catalyst function — there is no Python runtime
and no Presidio/spaCy equivalent, and introducing one would violate the
project's "one function" architecture (see `CLAUDE.md`). Catalyst's own Zia
service already exposes NER (`zia.getNERPrediction()`) through the same SDK
`functions/rag/vision.js` already uses for OCR/object-detection — that
replaces Presidio+spaCy with something already wired into this codebase.

One deliberate deviation from the reference: Sherlock returns the raw
entity map to the caller, who owns reversal. Sentinel instead keeps the map
server-side, behind the same clearance tier that already gates victim/
complainant identity in `redaction.js`, and logs reveals to the audit trail.

## Architecture

New sibling module `functions/rag/anonymize.js`, alongside `guard.js`,
`redaction.js`, `sources.js` — same convention as the rest of the safety
modules, not a new function. Two routes added to the router in
`functions/rag/index.js`, added after the existing gates so they inherit
session auth, IP blocking, CSRF, and rate limiting automatically:

```
POST .../anonymize/text     → handleAnonymize(req, res, 'anonymize')
POST .../anonymize/reveal   → handleAnonymize(req, res, 'reveal')
```

Both added to `METERED_ROUTES` (the `/text` route calls Zia; the `/reveal`
route touches identity data and should be rate-limited regardless of cost).

No new runtime, no new npm dependency, no new Catalyst service — Zia is
already provisioned and billed for this project.

## Entity detection

Two layers, merged:

1. **Regex recognizers** — a plain array of `{type, regex, score}` in
   `anonymize.js`, ported directly from the reference's `recognizers.yaml`
   patterns: FIR/case number (`\d+\/\d{4}`), `DD/MM/YYYY` and ISO
   date-times, Indian mobile numbers. Deterministic, free, instant.
2. **Zia NER** — `zia.getNERPrediction([text])` for PERSON and
   LOCATION-type entities the regex layer can't express. Injectable in
   `anonymize.js` as a parameter (defaults to the real Zia call) so tests
   can stub it without spending quota or requiring live serve.

**Overlap resolution** — ported from the reference's `overlapping.py`: when
two hits cover overlapping spans, keep the higher-scoring one. Regex hits
are scored `1`, so a domain pattern always wins over a fuzzy NER guess on
the same span.

**Known risk, to verify during implementation, not guessed here:** the
reference relies on Presidio's exact character offsets per entity. Zia's
NER response schema is not documented in the skill reference available at
design time — it may return only entity text + type, without offsets. If
so, replacement must fall back to word-boundary string matching, entities
sorted longest-match-first (so "Ravindra" isn't clobbered by a "Ravi"
match). This must be confirmed against a live Zia call before the
detection/replacement code is written, not assumed.

## Anonymization (consistent placeholders)

A JS port of the reference's `InstanceCounterAnonymizer`: a
`{ [entityType]: { [originalText]: placeholder } }` map, built fresh per
call. Same value maps to the same placeholder *within one call* (one
document/paste) — e.g. every occurrence of "Ravi Kumar" in one paste
becomes `PERSON_0`. Placeholder format: `TYPE_N` (e.g. `PERSON_0`,
`LOCATION_1`, `DATE_2`), matching the reference's convention.

Cross-call consistency (the same person getting the same placeholder
across two separate, unrelated paste sessions) is out of scope — flagged
as the ceiling of this design. Extending to that would require a
persistent, queryable entity-resolution store (fuzzy name matching across
documents), which is a materially bigger feature and not justified by the
current ask.

## Reversibility

- On `/anonymize/text`, the server generates a `mapId` (random UUID) and
  stores `{ owner: email, createdAt, entityMap }` at Stratus key
  `anonymize/maps/<mapId>.json`. The key is server-generated, never
  client-supplied, so `confineKey` doesn't apply here (no traversal
  surface to defend).
- The response is `{ mapId, anonymizedText, entityCounts }` — the raw
  `entityMap` is never returned to the caller.
- `POST .../anonymize/reveal` takes `{ mapId, text }` and replaces every
  placeholder found in `text` using the stored map — this works even if
  `text` is a report or third-party document built from the anonymized
  output, not just the original anonymized string verbatim (mirrors the
  reference's `/de-ano`, which is its stated selling point).
- Gated by `clearanceOf(role) >= PROTECTED_CLEARANCE` (reusing the
  existing tier from `redaction.js` — investigator/supervisor/admin, the
  same tier that already gates victim/complainant identity). A denied
  attempt and a successful reveal are both written to the audit trail via
  the existing audit logging path.
- Unknown `mapId` → 404. No map is ever deleted implicitly; a future TTL
  or manual-delete affordance is not part of this iteration.

`/anonymize/text` itself has no clearance requirement — any authenticated
officer can anonymize text before sharing it; only reversal is gated.

## Error handling

- Zia NER call fails or times out → fall back to regex-only detection,
  degrade rather than 500 the whole request. The response should indicate
  degraded detection (e.g. an `nerAvailable: false` flag) so the caller
  knows PERSON/LOCATION coverage may be incomplete.
- Empty or missing `text` → 400.
- `/anonymize/reveal` with unknown `mapId` → 404.
- `/anonymize/reveal` below clearance → 403, audit-logged as a denied
  access attempt (same shape as other clearance denials in the codebase).

## Frontend

One new page (route TBD during implementation, e.g. `/anonymize`):
textarea input, "Anonymize" action, result panel showing the anonymized
text (copyable) and entity-type counts (e.g. "PERSON: 3, LOCATION: 2").
Below that, a "Reveal" affordance — a text box to paste text back plus the
`mapId` — visible/enabled only when the signed-in officer's role clears
`PROTECTED_CLEARANCE`; otherwise omitted rather than shown-disabled, to
avoid advertising a capability the officer doesn't have.

No document/image upload UI in this iteration — text only, per scope.
Follows `DESIGN-linear.app.md` tokens (dark canvas, surface-1 card for the
input/output panels, lavender primary CTA for "Anonymize").

## Testing

Plain `functions/rag/anonymize.test.js`, following the repo's no-framework
`check(name, cond)` convention (`npm test` picks it up automatically):

- Regex recognizers match expected spans for FIR number / date / phone
  patterns.
- Overlap resolution keeps the higher-scoring entity when two recognizers
  claim overlapping spans.
- Same input value appearing twice in one call yields the same placeholder
  (consistency); different values of the same type get different
  placeholders.
- Reveal roundtrip: anonymize → reveal with the stored `mapId` reproduces
  the original text, including when reveal is run against text that has
  been modified around the placeholders (simulating a "third-party report"
  built from anonymized output).
- Clearance gating: reveal denied below `PROTECTED_CLEARANCE`, allowed at
  or above it.
- NER-unavailable fallback: with the injectable NER function forced to
  throw/reject, detection still returns regex hits and the response flags
  degraded detection.

`detectEntities` and `anonymizeText` should be plain, testable functions
that accept an injectable NER function, so the test suite never makes a
live Zia call (matches how other suites in this codebase avoid live
provider calls, e.g. `validator.test.js`).

## Open items carried into the implementation plan

1. Confirm Zia's actual `getNERPrediction` response shape (offsets or
   text-only) against a live call before writing the replacement logic.
2. Confirm the exact audit-log call shape used elsewhere in `index.js` so
   `/anonymize/reveal` logs in the same format as other clearance-gated
   actions.
3. Pick the final frontend route path and where it's linked from in the
   app's navigation.
