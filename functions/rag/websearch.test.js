// General web search: Tavily's live API, mocked so this suite runs offline
// and fast. Run: node functions/rag/websearch.test.js
//
// The response shape asserted here is Tavily's documented API contract, NOT
// yet verified against a real query the way sanctions.js's shape was (see
// websearch.js's header) — revisit this once there's a real key to test
// against.

const websearch = require('./websearch');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const originalFetch = global.fetch;
const originalKey = process.env.TAVILY_API_KEY;
function mockFetch(handler) { global.fetch = handler; }
function restore() {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = originalKey;
}

const DOCUMENTED_SHAPE_RESULT = {
  title: 'Bangalore City Police Official Website',
  url: 'https://bcp.karnataka.gov.in/',
  content: 'Official site of the Bangalore City Police, Karnataka.',
};

(async () => {
  process.env.TAVILY_API_KEY = 'test-key';

  // ── Input validation — no network call for an empty query ──────────────
  const empty = await websearch.search({ query: '' });
  check('an empty query is rejected without a network call', !!empty.error);
  const missing = await websearch.search({});
  check('a missing query is rejected the same way', !!missing.error);

  // ── Missing key reports unavailable, not a thrown error ─────────────────
  delete process.env.TAVILY_API_KEY;
  const noKey = await websearch.search({ query: 'anything' });
  check('no configured key reports unavailable, no network call', !!noKey.error);
  process.env.TAVILY_API_KEY = 'test-key';

  // ── A real match, shaped like the documented API response ──────────────
  mockFetch(async (url, opts) => {
    check('the request posts to the search endpoint', url === websearch.SEARCH_URL);
    check('the API key travels as a Bearer token, not in the URL',
      opts.headers.Authorization === 'Bearer test-key');
    const body = JSON.parse(opts.body);
    check('the query is sent in the JSON body', body.query === 'Bangalore City Police');
    return { ok: true, json: async () => ({ results: [DOCUMENTED_SHAPE_RESULT] }) };
  });
  const hit = await websearch.search({ query: 'Bangalore City Police' });
  check('a real match is reported found', hit.found === true);
  check('the match carries the title', hit.matches[0].title === DOCUMENTED_SHAPE_RESULT.title);
  check('the match carries the url', hit.matches[0].url === DOCUMENTED_SHAPE_RESULT.url);
  check('Tavily\'s "content" field becomes the match description',
    hit.matches[0].description === DOCUMENTED_SHAPE_RESULT.content);
  check('the sovereignty line names the actual destination', /Tavily/.test(hit.sovereignty));

  // ── A result missing "content" degrades, does not drop the result ──────
  mockFetch(async () => ({
    ok: true,
    json: async () => ({ results: [{ title: 'No content here', url: 'https://example.com' }] }),
  }));
  const noDesc = await websearch.search({ query: 'anything' });
  check('a missing content field does not drop the result', noDesc.matches.length === 1);
  check('a missing content field degrades to an empty description, not undefined', noDesc.matches[0].description === '');

  // ── No match ──────────────────────────────────────────────────────────
  mockFetch(async () => ({ ok: true, json: async () => ({ results: [] }) }));
  const noMatch = await websearch.search({ query: 'Nobody At All Xyzzy' });
  check('a genuine no-match is reported as found:false, not an error', noMatch.error === undefined && noMatch.found === false);

  // A response with no "results" key at all
  mockFetch(async () => ({ ok: true, json: async () => ({}) }));
  const noResultsKey = await websearch.search({ query: 'anything' });
  check('a response with no results key is treated as no match, not a crash', noResultsKey.found === false);

  // ── Failure modes fail soft, as a result, never a throw ──────────────────
  mockFetch(async () => ({ ok: false, status: 503 }));
  const httpFail = await websearch.search({ query: 'anyone' });
  check('an HTTP failure is reported as an error result, not thrown', !!httpFail.error);

  mockFetch(async () => { throw new Error('network down'); });
  let threw = false;
  try { await websearch.search({ query: 'anyone' }); } catch { threw = true; }
  check('a network exception is caught, not left to throw out of search()', !threw);

  restore();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
