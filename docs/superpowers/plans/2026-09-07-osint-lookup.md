# OSINT Lookup Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the assistant's tool loop an `osint_lookup` tool that answers "what do we know about this IP/domain" from RDAP (registration) and AbuseIPDB (IP reputation), the one capability every existing lane in Sentinel lacks — looking outside the platform's own data.

**Architecture:** A new standalone module `functions/rag/osint.js` (same shape as `legal.js`/`network.js`) does the actual lookups — format validation, then RDAP + AbuseIPDB in parallel, each failing soft independently. `functions/rag/tools.js` gets one new `DEFINITIONS` entry and one new dispatch `case`, with an inline role gate matching the existing `case_obligations` pattern. Nothing in `index.js` changes: the tool needs no Catalyst app, no ZCQL, no Stratus bucket — only `input.kind`, `input.value`, and the `role` every tool call already receives.

**Tech Stack:** Node.js (CommonJS), the platform's built-in global `fetch` (already used directly by the ORS integration in `index.js`, no new dependency), no test framework — the house `check()`-based `*.test.js` convention picked up automatically by `functions/rag/package.json`'s `npm test`.

**Spec:** `docs/superpowers/specs/2026-09-07-osint-lookup-design.md`

## Global Constraints

- Roles allowed to call the tool: `admin`, `supervisor`, `investigator`, `analyst` (no `policymaker`) — copied verbatim from the spec's Tool registration section.
- External timeouts: 12,000ms per source (RDAP and AbuseIPDB each), matching the codebase's existing external-call timeout for the ORS leg.
- `ABUSEIPDB_API_KEY` is optional; its absence must never fail the whole lookup — only the AbuseIPDB section reports `available:false`. Exact pattern already established by `ORS_API_KEY` in `handlePatrolDirections`.
- IP lookups only ever call rdap.org + api.abuseipdb.com. Domain lookups only ever call rdap.org — AbuseIPDB is never invoked for a domain.
- No frontend changes, no new route in `index.js`, no new audit-logging code, no redaction-filter changes — all explicitly out of scope per the spec.

---

### Task 1: `osint.js` lookup module

**Files:**
- Create: `functions/rag/osint.js`
- Test: `functions/rag/osint.test.js`

**Interfaces:**
- Produces: `osint.lookup({ kind, value }) -> Promise<result>` where `result` is either `{ error: string }` (malformed `kind`/`value`, no network call made) or `{ kind, value, rdap, abuseipdb, sovereignty }`. `rdap` and `abuseipdb` are each `{ available: false }` or `{ available: false, note }` on failure/absence, otherwise `{ available: true, ...fields }`.
- Produces: `osint.isValidIp(value) -> boolean`, `osint.isValidDomain(value) -> boolean` (exported for direct testing, same as `legal.js` exports its own helpers for `legal.test.js`).
- Consumes: nothing from other tasks — this module is self-contained.

- [ ] **Step 1: Write the failing test file**

Create `functions/rag/osint.test.js`:

```js
// OSINT lookup: format validation, and that one external source failing (or
// AbuseIPDB's key being unset) never takes the other source down with it.
// Run: node functions/rag/osint.test.js

const osint = require('./osint');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// ── Format validation ────────────────────────────────────────────────────
check('a plausible IPv4 address is valid', osint.isValidIp('8.8.8.8'));
check('an out-of-range octet is rejected', !osint.isValidIp('8.8.8.999'));
check('a five-part address is not valid', !osint.isValidIp('8.8.8.8.8'));
check('a plausible IPv6 address is valid', osint.isValidIp('2001:4860:4860::8888'));
check('a plausible domain is valid', osint.isValidDomain('example.com'));
check('a domain with a leading hyphen is not', !osint.isValidDomain('-example.com'));
check('a bare word with no TLD is not a valid domain', !osint.isValidDomain('localhost'));
check('a value with a space is not a valid domain', !osint.isValidDomain('exa mple.com'));

// ── Mocked network: fail-soft independence between the two sources ────────
//
// Neither rdapLookup nor abuseIpdbLookup may throw or let one source's
// failure affect the other's — this fakes global.fetch (the same global the
// ORS integration in index.js already calls directly) so both branches run
// without a real network call.
const originalFetch = global.fetch;
const originalKey = process.env.ABUSEIPDB_API_KEY;
function mockFetch(handlers) {
  global.fetch = async (url) => {
    const hit = handlers.find(([match]) => String(url).includes(match));
    if (!hit) throw new Error(`unexpected fetch to ${url}`);
    return hit[1]();
  };
}
function restoreEnv() {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.ABUSEIPDB_API_KEY;
  else process.env.ABUSEIPDB_API_KEY = originalKey;
}

(async () => {
  // A malformed kind or value never reaches the network at all.
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; throw new Error('should not be called'); };
  const badKind = await osint.lookup({ kind: 'phone', value: '8.8.8.8' });
  check('an unknown kind is refused before any network call', /Unknown kind/.test(badKind.error || ''));
  const badIp = await osint.lookup({ kind: 'ip', value: 'not-an-ip' });
  check('a malformed IP is refused before any network call', /not a valid IP/.test(badIp.error || ''));
  const badDomain = await osint.lookup({ kind: 'domain', value: 'not a domain' });
  check('a malformed domain is refused before any network call', /not a valid domain/.test(badDomain.error || ''));
  check('none of the rejections touched the network', fetchCalls === 0);

  // Both sources answer.
  process.env.ABUSEIPDB_API_KEY = 'test-key';
  mockFetch([
    ['rdap.org', () => ({ ok: true, json: async () => ({
      handle: 'NET-8-8-8-0-1', country: 'US',
      entities: [{ roles: ['registrant'], vcardArray: [null, [['fn', {}, 'text', 'Google LLC']]] }],
      status: ['active'], events: [],
    }) })],
    ['abuseipdb.com', () => ({ ok: true, json: async () => ({ data: {
      abuseConfidenceScore: 0, totalReports: 0, isWhitelisted: true,
      countryCode: 'US', isp: 'Google LLC', domain: 'google.com', usageType: 'Data Center/Web Hosting',
      lastReportedAt: null,
    } }) })],
  ]);
  const both = await osint.lookup({ kind: 'ip', value: '8.8.8.8' });
  check('RDAP data comes back when the source answers',
    both.rdap.available === true && both.rdap.name === 'Google LLC');
  check('AbuseIPDB data comes back when the source answers',
    both.abuseipdb.available === true && both.abuseipdb.isp === 'Google LLC');
  check('the sovereignty note names both external services for an IP lookup',
    /rdap\.org/.test(both.sovereignty) && /abuseipdb\.com/.test(both.sovereignty));

  // RDAP down, AbuseIPDB still answers — one source's outage never blanks the other.
  mockFetch([
    ['rdap.org', () => { throw new Error('network down'); }],
    ['abuseipdb.com', () => ({ ok: true, json: async () => ({ data: {
      abuseConfidenceScore: 12, totalReports: 3, isWhitelisted: false,
      countryCode: 'US', isp: 'Example ISP', domain: null, usageType: 'ISP', lastReportedAt: '2026-01-01',
    } }) })],
  ]);
  const rdapDown = await osint.lookup({ kind: 'ip', value: '8.8.8.8' });
  check('RDAP outage reports unavailable, not an error', rdapDown.rdap.available === false);
  check('AbuseIPDB still answers when RDAP is down',
    rdapDown.abuseipdb.available === true && rdapDown.abuseipdb.abuseConfidenceScore === 12);

  // No AbuseIPDB key configured — RDAP still answers, AbuseIPDB says unavailable
  // rather than the whole lookup failing (the ORS_API_KEY pattern).
  delete process.env.ABUSEIPDB_API_KEY;
  mockFetch([
    ['rdap.org', () => ({ ok: true, json: async () => ({
      handle: 'NET-8-8-8-0-1', country: 'US', entities: [], status: ['active'], events: [],
    }) })],
  ]);
  const noKey = await osint.lookup({ kind: 'ip', value: '8.8.8.8' });
  check('with no AbuseIPDB key, that source reports unavailable', noKey.abuseipdb.available === false);
  check('RDAP is unaffected by the missing AbuseIPDB key', noKey.rdap.available === true);

  // Domain lookups never call AbuseIPDB at all — it has nothing to say about a
  // domain, and the tool should not even attempt the call.
  let abuseipdbCalled = false;
  process.env.ABUSEIPDB_API_KEY = 'test-key';
  mockFetch([
    ['rdap.org', () => ({ ok: true, json: async () => ({
      handle: 'example.com', status: ['active'], events: [], entities: [],
    }) })],
    ['abuseipdb.com', () => { abuseipdbCalled = true; return { ok: true, json: async () => ({ data: {} }) }; }],
  ]);
  const domain = await osint.lookup({ kind: 'domain', value: 'example.com' });
  check('a domain lookup never calls AbuseIPDB', !abuseipdbCalled);
  check('AbuseIPDB is reported unavailable for a domain, with a reason',
    domain.abuseipdb.available === false && /IP addresses only/.test(domain.abuseipdb.note || ''));
  check('the sovereignty note for a domain does not mention AbuseIPDB',
    !/abuseipdb\.com/.test(domain.sovereignty));

  restoreEnv();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node functions/rag/osint.test.js`
Expected: `Error: Cannot find module './osint'` — `osint.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `functions/rag/osint.js`:

```js
'use strict';

// OSINT lookup — external reputation/registration data for an IP address or
// domain. This is the one gap every other lane in this codebase shares: RAG,
// ZCQL and the tool loop all answer from data already inside Sentinel, and
// nothing anywhere looks outside it. Two sources, each optional and each
// independent of the other, so one being down never takes out the whole
// answer:
//
//   RDAP      — registration data (who holds this address block / who
//               registered this domain). Free, keyless, via rdap.org's
//               bootstrap redirector.
//   AbuseIPDB — IP reputation (abuse reports, confidence score). Free-tier
//               keyed; ABUSEIPDB_API_KEY unset means this section reports
//               unavailable rather than the whole lookup failing — the same
//               shape ORS_API_KEY already uses for patrol directions.
//
// Both requests leave Sentinel's own infrastructure and India's data centre.
// Only the bare identifier travels — no case content, no officer identity —
// but that is still worth surfacing to the officer, which is why the tool
// definition in tools.js instructs the model to state it plainly rather than
// leaving it buried in a result field nobody reads.

const RDAP_TIMEOUT_MS = 12_000;
const ABUSEIPDB_TIMEOUT_MS = 12_000;

// Validated before any network call, so a malformed value costs nothing
// rather than becoming a URL path. Not a security boundary — a value that
// slips past this just gets a 404 from rdap.org — only a sanity filter.
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,45}$/;
const DOMAIN_RE = /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*\.[a-zA-Z]{2,}$/;

function isValidIp(v) {
  const s = String(v || '').trim();
  if (IPV4_RE.test(s)) return s.split('.').every((o) => Number(o) <= 255);
  return IPV6_RE.test(s) && s.includes(':');
}

function isValidDomain(v) {
  return DOMAIN_RE.test(String(v || '').trim());
}

async function fetchJson(url, opts, timeoutMs) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function rdapLookup(kind, value) {
  const path = kind === 'ip' ? 'ip' : 'domain';
  const data = await fetchJson(`https://rdap.org/${path}/${encodeURIComponent(value)}`, {}, RDAP_TIMEOUT_MS);
  if (!data) return { available: false };
  // RDAP's shape varies by registry; lift the handful of fields an officer
  // actually reads rather than passing the whole document through.
  const entities = Array.isArray(data.entities) ? data.entities : [];
  const registrant = entities.find((e) => (e.roles || []).includes('registrant'))
    || entities.find((e) => (e.roles || []).includes('registrar'))
    || entities[0];
  const vcard = (registrant && registrant.vcardArray && registrant.vcardArray[1]) || [];
  const nameField = vcard.find((f) => f[0] === 'fn');
  return {
    available: true,
    handle: data.handle || null,
    name: nameField ? nameField[3] : ((registrant && registrant.handle) || null),
    country: data.country || null,
    startAddress: data.startAddress || null,
    endAddress: data.endAddress || null,
    status: Array.isArray(data.status) ? data.status : [],
    events: Array.isArray(data.events)
      ? data.events.slice(0, 5).map((e) => ({ action: e.eventAction, date: e.eventDate }))
      : [],
  };
}

async function abuseIpdbLookup(value) {
  const key = process.env.ABUSEIPDB_API_KEY;
  if (!key) return { available: false };
  const data = await fetchJson(
    `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(value)}&maxAgeInDays=90`,
    { headers: { Key: key, Accept: 'application/json' } },
    ABUSEIPDB_TIMEOUT_MS,
  );
  const d = data && data.data;
  if (!d) return { available: false };
  return {
    available: true,
    abuseConfidenceScore: d.abuseConfidenceScore,
    totalReports: d.totalReports,
    isWhitelisted: !!d.isWhitelisted,
    countryCode: d.countryCode || null,
    isp: d.isp || null,
    domain: d.domain || null,
    usageType: d.usageType || null,
    lastReportedAt: d.lastReportedAt || null,
  };
}

/**
 * Look up an IP address or domain against external OSINT sources.
 *
 * Returns { error } for a malformed kind/value, with no network call made.
 * Otherwise always returns { kind, value, rdap, abuseipdb, sovereignty } —
 * each source section is independently { available:false } on failure or
 * absence. Never throws: a source outage is a result, not an exception.
 */
async function lookup({ kind, value }) {
  if (kind !== 'ip' && kind !== 'domain') {
    return { error: `Unknown kind "${kind}". Use "ip" or "domain".` };
  }
  const v = String(value || '').trim();
  if (kind === 'ip' && !isValidIp(v)) {
    return { error: `"${value}" is not a valid IP address.` };
  }
  if (kind === 'domain' && !isValidDomain(v)) {
    return { error: `"${value}" is not a valid domain.` };
  }

  const [rdap, abuseipdb] = await Promise.all([
    rdapLookup(kind, v),
    kind === 'ip'
      ? abuseIpdbLookup(v)
      : Promise.resolve({ available: false, note: 'AbuseIPDB covers IP addresses only.' }),
  ]);

  return {
    kind,
    value: v,
    rdap,
    abuseipdb,
    sovereignty: `Looking up ${kind === 'ip' ? 'an IP address' : 'a domain'} sends it to `
      + `rdap.org${kind === 'ip' ? ' and api.abuseipdb.com' : ''}, outside Sentinel and outside India. `
      + 'Nothing else about this case travels with it.',
  };
}

module.exports = { lookup, isValidIp, isValidDomain };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node functions/rag/osint.test.js`
Expected: every `check(...)` prints `ok`, final line `26 passed, 0 failed` (or similar — count depends on the exact test list above), exit code 0.

- [ ] **Step 5: Commit**

```bash
git add functions/rag/osint.js functions/rag/osint.test.js
git commit -m "$(cat <<'EOF'
feat(osint): add RDAP + AbuseIPDB lookup module

Standalone module, not yet wired into the assistant. IP and domain
registration via RDAP (free, keyless); IP reputation via AbuseIPDB
(free-tier keyed, ABUSEIPDB_API_KEY optional and fail-soft — same
pattern ORS_API_KEY already uses for patrol directions). Each source
fails independently so one outage never blanks the other.
EOF
)"
```

---

### Task 2: Wire `osint_lookup` into the assistant's tool loop

**Files:**
- Modify: `functions/rag/tools.js`
- Modify: `functions/rag/tools.test.js`

**Interfaces:**
- Consumes: `osint.lookup({ kind, value })` from Task 1, exactly as specified there.
- Produces: `osint_lookup` reachable via the existing `tools.run(name, input, deps)` entry point, where `deps.role` gates access. No other module depends on anything new from this task — this is the leaf that plugs the tool into the loop.

- [ ] **Step 1: Write the failing tests**

In `functions/rag/tools.test.js`, add near the top (after the existing `const zcql = require('./zcql');` / `const redaction = require('./redaction');` lines) nothing new is needed as an import — `tools.js` itself requires `osint.js` internally. Add this block after the existing "── case_obligations ──" section (i.e. after the `for (const role of ['investigator', 'supervisor', 'admin'])` loop and its closing check, before the "── The system prompt itself ──" section), inside the same `(async () => { ... })()` IIFE so it runs with the rest:

```js
  // ── osint_lookup ─────────────────────────────────────────────────────
  //
  // The one tool here that reaches outside Sentinel entirely. Two things
  // matter: the role gate has to run before any lookup happens (an unentitled
  // role must never even reach osint.js, let alone the network), and the tool
  // definition has to tell the model this leaves the country, because nothing
  // downstream will say so if the definition doesn't.

  check('the OSINT tool discloses that the lookup leaves Sentinel and India',
    /outside Sentinel and outside India/.test(
      tools.DEFINITIONS.find((d) => d.name === 'osint_lookup').description));

  // Deliberately malformed values below: the gate must pass THROUGH to
  // osint.js's own validation (proving the tool is actually wired up) without
  // ever reaching the network, which is what makes this safe to run with no
  // mocking.
  for (const role of ['investigator', 'supervisor', 'admin', 'analyst']) {
    const ok = await run('osint_lookup', { kind: 'ip', value: 'not-an-ip' }, { role });
    check(`${role} can reach the OSINT lookup (gate passes)`,
      /not a valid IP/.test(ok.error || ''), JSON.stringify(ok));
  }
  const osintDenied = await run('osint_lookup', { kind: 'ip', value: '8.8.8.8' }, { role: 'policymaker' });
  check('policymaker cannot reach OSINT lookups through the assistant',
    /limited to investigators, supervisors, analysts and admin/.test(osintDenied.error || ''));
  const osintNoRole = await run('osint_lookup', { kind: 'ip', value: '8.8.8.8' }, {});
  check('an uncleared caller cannot reach OSINT lookups either',
    /limited to investigators, supervisors, analysts and admin/.test(osintNoRole.error || ''));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node functions/rag/tools.test.js`
Expected: `FAIL the OSINT tool discloses...` (no such definition exists yet — `tools.DEFINITIONS.find(...)` returns `undefined`, so `.description` throws, which will actually crash the whole IIFE with a `TypeError`, cutting the run short with a non-zero exit — that crash IS the expected failure here). Confirm the crash names `osint_lookup` / `Cannot read properties of undefined`.

- [ ] **Step 3: Write the implementation**

In `functions/rag/tools.js`:

1. Add the require near the top, alongside the other sibling-module requires:

```js
const zcql = require('./zcql');
const redaction = require('./redaction');
const masters = require('./masters.json');
const network = require('./network');
const legal = require('./legal');
const guard = require('./guard');
const osint = require('./osint');
```

2. Add a new entry to `DEFINITIONS`, after the `case_obligations` entry (i.e. as the last element of the array, immediately before the closing `];`):

```js
  {
    name: 'osint_lookup',
    description:
      'Look up what is publicly known about an IP address or domain: RDAP ' +
      'registration data for both, and AbuseIPDB abuse-reputation data for ' +
      'IP addresses. Use this when an officer asks about an IP or domain ' +
      'found in evidence — who it is registered to, whether it has a ' +
      'history of abuse reports — not for anything already in the Data ' +
      'Store.\n\n' +
      'This sends the identifier to external services (rdap.org, and ' +
      'api.abuseipdb.com for IP addresses), outside Sentinel and outside ' +
      'India. State that plainly in your answer — do not let the officer ' +
      'assume this came from an internal record. Nothing besides the bare ' +
      'identifier travels with the request.',
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['ip', 'domain'],
          description: 'Whether value is an IP address or a domain name.',
        },
        value: {
          type: 'string',
          description: 'The IP address or domain to look up.',
        },
      },
      required: ['kind', 'value'],
    },
  },
```

3. Add a new `case` to the `switch (name)` inside `run()`, after the `case 'case_obligations':` block and before `default:`:

```js
      case 'osint_lookup': {
        // Same gate shape as case_obligations: checked inline at dispatch so
        // a new tool cannot forget it. Analyst is included here (unlike
        // case_obligations) because this is public registration/reputation
        // data about an internet identifier, not a case record — an
        // analyst's need-to-know covers it.
        if (!['admin', 'supervisor', 'investigator', 'analyst'].includes(role)) {
          return { error: 'OSINT lookups are limited to investigators, supervisors, analysts and admin.' };
        }
        return await osint.lookup(input || {});
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node functions/rag/tools.test.js`
Expected: every `check(...)` prints `ok`, final line reports `0 failed`, exit code 0.

Also re-run Task 1's suite to confirm nothing there regressed: `node functions/rag/osint.test.js` — expected unchanged, `0 failed`.

Also run the full backend suite once, since a new `require('./osint')` from `tools.js` means anything that loads `tools.js` now transitively loads `osint.js`: `cd functions/rag && npm test` — expected every suite still prints `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add functions/rag/tools.js functions/rag/tools.test.js
git commit -m "$(cat <<'EOF'
feat(osint): wire osint_lookup into the assistant's tool loop

Eighth tool alongside query_records, traverse_network, etc. Role gate
inline at dispatch (admin/supervisor/investigator/analyst, no
policymaker), matching the case_obligations pattern. No index.js
changes needed — the tool takes only its own input and the role every
tool call already receives. Reached purely by the model choosing to
call it; no new page, route, or UI anywhere.
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** "New module: osint.js" → Task 1. "Tool registration: tools.js" → Task 2. "Error handling" section's four cases (invalid input, RDAP down, AbuseIPDB down/unkeyed, role gate failure) are each asserted by a specific test in Task 1 or Task 2. "Testing" section's three requirements (format validation, fail-soft-per-source via mocked fetch, role gate exercised through the real dispatch) are each Task 1 Step 1 / Task 1 Step 1 / Task 2 Step 1. "Explicitly not built" section requires no task — it is exactly the set of files this plan does not touch.
- **Placeholder scan:** none — every step carries complete, runnable code.
- **Type consistency:** `osint.lookup({ kind, value })` signature is identical across the spec, Task 1's implementation, and Task 2's dispatch call (`osint.lookup(input || {})`, where `input` is the model's `{kind, value}` tool-call argument). `isValidIp`/`isValidDomain` are defined and exported in Task 1, consumed only by Task 1's own tests — Task 2 never calls them directly, only through `lookup`.
