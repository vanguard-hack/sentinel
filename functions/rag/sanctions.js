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
const PROFILE_URL = 'https://www.opensanctions.org/entities/';
const FETCH_TIMEOUT_MS = 12_000;
const MAX_MATCHES = 10;

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

module.exports = { SEARCH_URL, PROFILE_URL, MAX_MATCHES, search };
