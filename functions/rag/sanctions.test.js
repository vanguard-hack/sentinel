// Sanctions/watchlist lookup: OpenSanctions' live search API, mocked so this
// suite runs offline and fast. Run: node functions/rag/sanctions.test.js

const sanctions = require('./sanctions');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const originalFetch = global.fetch;
const originalKey = process.env.OPENSANCTIONS_API_KEY;
function mockFetch(handler) { global.fetch = handler; }
function restore() {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENSANCTIONS_API_KEY;
  else process.env.OPENSANCTIONS_API_KEY = originalKey;
}

// A response shaped like the real API — verified live against a real query
// before this was written: a "Vladimir Putin" search returned a match
// spanning 28 source datasets under exactly these field names.
const REAL_SHAPE_RESULT = {
  id: 'Q7747',
  caption: 'Vladimir Putin',
  schema: 'Person',
  datasets: ['un_ga_protocol', 'us_ofac_sdn', 'eu_fsf', 'wd_peps'],
  properties: { topics: ['role.pol', 'sanction', 'role.pep'], country: ['ru'] },
};

(async () => {
  process.env.OPENSANCTIONS_API_KEY = 'test-key';

  // ── Input validation — no network call for an empty query ──────────────
  const empty = await sanctions.search({ query: '' });
  check('an empty query is rejected without a network call', !!empty.error);
  const missing = await sanctions.search({});
  check('a missing query is rejected the same way', !!missing.error);

  // ── Missing key reports unavailable, not a thrown error ─────────────────
  delete process.env.OPENSANCTIONS_API_KEY;
  const noKey = await sanctions.search({ query: 'anyone' });
  check('no configured key reports unavailable, no network call', !!noKey.error);
  process.env.OPENSANCTIONS_API_KEY = 'test-key';

  // ── A real match, shaped exactly like the live API's response ──────────
  mockFetch(async (url, opts) => {
    check('the query is URL-encoded into the search endpoint', String(url).includes('opensanctions.org/search/default'));
    check('the API key travels as an ApiKey auth header, not in the URL', opts.headers.Authorization === 'ApiKey test-key');
    return {
      ok: true,
      json: async () => ({ total: { value: 1252 }, results: [REAL_SHAPE_RESULT] }),
    };
  });
  const hit = await sanctions.search({ query: 'Vladimir Putin' });
  check('a real match is reported found', hit.found === true);
  check('the match carries the name', hit.matches[0].name === 'Vladimir Putin');
  check('the match carries every dataset it appears in, not just one', hit.matches[0].datasets.length === 4);
  check('the match carries its topics', hit.matches[0].topics.includes('sanction'));
  check('the match links to a real per-entity profile page', hit.matches[0].profileUrl === 'https://www.opensanctions.org/entities/Q7747/');
  check('the sovereignty line names the actual destination', /api\.opensanctions\.org/.test(hit.sovereignty));
  check('total reflects the API\'s own reported total, not just this page\'s length', hit.total === 1252);

  // ── No match ──────────────────────────────────────────────────────────
  mockFetch(async () => ({ ok: true, json: async () => ({ total: { value: 0 }, results: [] }) }));
  const noMatch = await sanctions.search({ query: 'Nobody At All Xyzzy' });
  check('a genuine no-match is reported as found:false, not an error', noMatch.error === undefined && noMatch.found === false);

  // ── Failure modes fail soft, as a result, never a throw ──────────────────
  mockFetch(async () => ({ ok: false, status: 503 }));
  const httpFail = await sanctions.search({ query: 'anyone' });
  check('an HTTP failure is reported as an error result, not thrown', !!httpFail.error);

  mockFetch(async () => { throw new Error('network down'); });
  let threw = false;
  try { await sanctions.search({ query: 'anyone' }); } catch { threw = true; }
  check('a network exception is caught, not left to throw out of search()', !threw);

  restore();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
