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
