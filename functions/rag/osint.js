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

// rdap.org's edge blocks requests carrying no User-Agent (or Node's default,
// undistinguished one) with a 403 from its bot-protection layer, even though
// the exact same request with an ordinary client UA succeeds — verified
// directly against the live service, not assumed. Every call through here
// carries one, since AbuseIPDB's edge could start doing the same tomorrow.
const USER_AGENT = 'Sentinel-OSINT/1.0 (Karnataka State Police crime platform)';

async function fetchJson(url, opts, timeoutMs) {
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': USER_AGENT, ...(opts && opts.headers) },
      signal: AbortSignal.timeout(timeoutMs),
    });
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
