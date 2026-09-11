'use strict';

// General web search — Tavily's search API, for real-world facts that are
// true outside Sentinel entirely (a current office-holder, a public event, a
// company) and have no business being in the Data Store or the knowledge
// base. Live per query, the same shape as osint.js/sanctions.js/crypto.js:
// no local cache, because there is nothing stable enough here to cache — the
// whole point is that this answers questions the other tools structurally
// cannot.
//
// Chosen over Brave Search (the original choice) because Brave requires a
// card on file even for its free tier; Tavily's free tier refills monthly
// with no card, and unlike a raw SERP API it's built specifically for LLM
// tool results — clean title/url/content per result, not HTML to scrape.
// The response shape below (results[].{title,url,content}) is Tavily's
// documented schema (docs.tavily.com/documentation/api-reference/endpoint/search),
// not yet verified against a real query the way sanctions.js's shape was —
// revisit once there's a real key to test against.

const SEARCH_URL = 'https://api.tavily.com/search';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_MATCHES = 5;

/**
 * Search the open web for a query.
 *
 * Returns { error } only for a missing/empty query, with no network call.
 * A network failure or missing API key is reported as { error }, not
 * thrown — the tool built on this reports it as a lookup that could not
 * run, never as a silent "found nothing".
 */
async function search({ query } = {}) {
  const q = String(query || '').trim();
  if (!q) return { error: 'A query is required to search the web.' };

  const key = process.env.TAVILY_API_KEY;
  if (!key) return { error: 'Web search is not configured.' };

  let data;
  try {
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: q, max_results: MAX_MATCHES }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `Web search failed: HTTP ${res.status}` };
    data = await res.json();
  } catch (e) {
    return { error: `Web search failed: ${(e && e.message) || e}` };
  }

  const results = Array.isArray(data && data.results) ? data.results : [];
  const matches = results.slice(0, MAX_MATCHES).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    description: r.content || '',
  }));

  return {
    query: q,
    found: matches.length > 0,
    matches,
    sovereignty: `Searching "${q}" sends it to Tavily, outside Sentinel and outside India. `
      + 'Nothing else about this case travels with it.',
  };
}

module.exports = { SEARCH_URL, MAX_MATCHES, search };
