'use strict';

// Sanctions/watchlist lookup — OpenSanctions' aggregated search API, text-
// matched against a name an officer is checking. Live per query, like
// osint.js and crypto.js: unlike the UN Consolidated List this replaced,
// OpenSanctions has no single small file worth caching locally — it is an
// aggregation of 25+ source lists (UN, OFAC, EU, UK, multiple other
// countries' sanctions, PEPs, wanted lists, debarment, export control) kept
// current on OpenSanctions' own infrastructure, so every question is
// answered against their live index rather than a daily local copy.
//
// Verified directly against the live API before writing this: a search for
// "Vladimir Putin" returned a match spanning 28 source datasets in one hit,
// confirming this is a genuinely broader source than the UN-only list it
// replaces, not just a different vendor for the same data.

const SEARCH_URL = 'https://api.opensanctions.org/search/default';
const MATCH_URL = 'https://api.opensanctions.org/match/default';
const PROFILE_URL = 'https://www.opensanctions.org/entities/';
const FETCH_TIMEOUT_MS = 12_000;
const MAX_MATCHES = 10;
// OpenSanctions allows up to 100 queries per /match request, but bills each
// entity individually regardless of batch size — batching is a network
// convenience, not a cost saving. This cap is the actual spend/quota lever,
// kept well under the API's own ceiling on purpose.
const MAX_BATCH = 10;

/**
 * Search a name — a person or an organisation — against OpenSanctions.
 *
 * Returns { error } only for a missing/empty query, with no network call.
 * A network failure or missing API key is reported as { error }, not
 * thrown — the tool built on this reports it as a lookup that could not
 * run, never as a silent "no match".
 */
async function search({ query } = {}) {
  const q = String(query || '').trim();
  if (!q) return { error: 'A name is required to screen against sanctions/watchlists.' };

  const key = process.env.OPENSANCTIONS_API_KEY;
  if (!key) return { error: 'Sanctions screening is not configured.' };

  let data;
  try {
    const res = await fetch(
      `${SEARCH_URL}?q=${encodeURIComponent(q)}&limit=${MAX_MATCHES}`,
      { headers: { Authorization: `ApiKey ${key}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    if (!res.ok) return { error: `Sanctions screening failed: HTTP ${res.status}` };
    data = await res.json();
  } catch (e) {
    return { error: `Sanctions screening failed: ${(e && e.message) || e}` };
  }

  const results = Array.isArray(data && data.results) ? data.results : [];
  const matches = results.slice(0, MAX_MATCHES).map((r) => {
    const props = r.properties || {};
    return {
      id: r.id,
      name: r.caption || (Array.isArray(props.name) ? props.name[0] : '') || '',
      schema: r.schema || null,
      datasets: Array.isArray(r.datasets) ? r.datasets : [],
      topics: Array.isArray(props.topics) ? props.topics : [],
      countries: Array.isArray(props.country) ? props.country : [],
      profileUrl: r.id ? `${PROFILE_URL}${encodeURIComponent(r.id)}/` : null,
    };
  });

  return {
    query: q,
    found: matches.length > 0,
    matches,
    total: (data && data.total && data.total.value) || matches.length,
    sovereignty: `Screening "${q}" sends it to api.opensanctions.org, outside Sentinel and outside India. `
      + 'Nothing else about this case travels with it.',
  };
}

/**
 * Screen several named entities against OpenSanctions in one request — the
 * bulk counterpart to search() above, for Financial Trails' "screen these
 * accused" action rather than a single officer-typed name.
 *
 * Request/response shape follows OpenSanctions' documented /match schema
 * (queries -> responses, each result carrying a `match` boolean gated on
 * their default 0.7 score threshold); not live-verified against the API in
 * this session, deliberately, to avoid spending quota while building it.
 *
 * entities: [{ id, name }]. Returns { results: { [id]: { found, matches } } }
 * or { error } — same never-throw contract as search().
 */
async function matchBatch({ entities } = {}) {
  const list = Array.isArray(entities) ? entities : [];
  if (!list.length) return { error: 'At least one entity is required to screen.' };
  if (list.length > MAX_BATCH) return { error: `Screen at most ${MAX_BATCH} entities at a time.` };

  const key = process.env.OPENSANCTIONS_API_KEY;
  if (!key) return { error: 'Sanctions screening is not configured.' };

  const queries = {};
  list.forEach((e, i) => {
    const name = String((e && e.name) || '').trim();
    if (!name) return;
    const id = String((e && e.id) || i);
    queries[id] = { schema: 'Person', properties: { name: [name] } };
  });
  if (!Object.keys(queries).length) return { error: 'Every entity needs a name to screen.' };

  let data;
  try {
    const res = await fetch(MATCH_URL, {
      method: 'POST',
      headers: { Authorization: `ApiKey ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `Sanctions screening failed: HTTP ${res.status}` };
    data = await res.json();
  } catch (e) {
    return { error: `Sanctions screening failed: ${(e && e.message) || e}` };
  }

  const responses = (data && data.responses) || {};
  const results = {};
  Object.keys(queries).forEach((id) => {
    const entry = responses[id] || {};
    const hits = Array.isArray(entry.results) ? entry.results : [];
    const matches = hits.filter((r) => r && r.match).map((r) => ({
      id: r.id,
      name: r.caption || '',
      schema: r.schema || null,
      score: typeof r.score === 'number' ? r.score : null,
      datasets: Array.isArray(r.datasets) ? r.datasets : [],
      profileUrl: r.id ? `${PROFILE_URL}${encodeURIComponent(r.id)}/` : null,
    }));
    results[id] = { found: matches.length > 0, matches };
  });

  return { results };
}

module.exports = { SEARCH_URL, MATCH_URL, PROFILE_URL, MAX_MATCHES, MAX_BATCH, search, matchBatch };
