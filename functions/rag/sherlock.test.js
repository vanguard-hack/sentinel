// Username lookup (Sherlock via Apify): start + poll, mocked so this suite
// runs offline and fast. Run: node functions/rag/sherlock.test.js

const sherlock = require('./sherlock');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const originalFetch = global.fetch;
const originalToken = process.env.APIFY_API_TOKEN;
function mockFetch(handler) { global.fetch = handler; }
function restore() {
  global.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.APIFY_API_TOKEN;
  else process.env.APIFY_API_TOKEN = originalToken;
}

(async () => {
  process.env.APIFY_API_TOKEN = 'test-token';

  // ── Username validation ──────────────────────────────────────────────
  check('a plausible username is valid', sherlock.isValidUsername('johndoe'));
  check('an empty username is not', !sherlock.isValidUsername(''));
  check('a username containing a space is not', !sherlock.isValidUsername('john doe'));
  check('an absurdly long username is not', !sherlock.isValidUsername('a'.repeat(65)));

  // ── startRun: bad input never reaches the network ───────────────────────
  let calls = 0;
  mockFetch(async () => { calls++; throw new Error('should not fetch'); });
  const badStart = await sherlock.startRun({ username: 'john doe' });
  check('a malformed username is rejected without a network call', !!badStart.error && calls === 0);

  // ── startRun: no token configured ────────────────────────────────────
  delete process.env.APIFY_API_TOKEN;
  const noToken = await sherlock.startRun({ username: 'johndoe' });
  check('no configured token reports unavailable, no network call', !!noToken.error && calls === 0);
  process.env.APIFY_API_TOKEN = 'test-token';

  // ── startRun: a real start, shaped like Apify's actual response ─────────
  mockFetch(async (url, opts) => {
    check('the start call POSTs to the actor\'s /runs endpoint',
      String(url) === 'https://api.apify.com/v2/acts/sSuwVmyjxzabXcoMh/runs');
    check('the token travels as a Bearer auth header', opts.headers.Authorization === 'Bearer test-token');
    check('the username travels as an array, matching the actor\'s input schema',
      JSON.parse(opts.body).usernames[0] === 'johndoe');
    return { ok: true, status: 201, json: async () => ({ data: { id: 'run-abc-123', status: 'READY' } }) };
  });
  const started = await sherlock.startRun({ username: 'johndoe' });
  check('a successful start returns the run id', started.runId === 'run-abc-123');

  // ── startRun: a failed start fails soft ──────────────────────────────
  mockFetch(async () => ({ ok: false, status: 402 }));
  const startFail = await sherlock.startRun({ username: 'johndoe' });
  check('a failed start is reported as an error, not thrown', !!startFail.error);

  // ── pollRun: still running ───────────────────────────────────────────
  mockFetch(async (url) => {
    check('the poll call GETs the run status endpoint',
      String(url) === 'https://api.apify.com/v2/actor-runs/run-abc-123');
    return { ok: true, json: async () => ({ data: { id: 'run-abc-123', status: 'RUNNING' } }) };
  });
  const running = await sherlock.pollRun({ runId: 'run-abc-123' });
  check('a run still in progress is reported as running, not an error', running.status === 'running');

  // ── pollRun: succeeded — fetches the dataset too ─────────────────────
  let fetchedDataset = false;
  mockFetch(async (url) => {
    if (String(url).includes('/actor-runs/')) {
      return { ok: true, json: async () => ({ data: { id: 'run-abc-123', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } }) };
    }
    check('a succeeded run fetches its dataset by the id the run reported',
      String(url) === 'https://api.apify.com/v2/datasets/ds-1/items');
    fetchedDataset = true;
    return { ok: true, json: async () => ([{ username: 'johndoe', links: ['https://example.com/johndoe'] }]) };
  });
  const done = await sherlock.pollRun({ runId: 'run-abc-123' });
  check('the dataset was actually fetched once succeeded', fetchedDataset);
  check('a succeeded run reports done with the username and links', done.status === 'done' && done.username === 'johndoe' && done.links.length === 1);
  check('the sovereignty line names the actual destination', /Apify/.test(done.sovereignty));

  // ── pollRun: succeeded, but the actor returned an object per link ────
  // Documented as an array of plain URL strings; live runs have been
  // observed returning objects instead — a real "[object Object]" bug that
  // reached officers before links were normalized before leaving pollRun.
  mockFetch(async (url) => {
    if (String(url).includes('/actor-runs/')) {
      return { ok: true, json: async () => ({ data: { id: 'run-abc-123', status: 'SUCCEEDED', defaultDatasetId: 'ds-2' } }) };
    }
    return {
      ok: true,
      json: async () => ([{
        username: 'johndoe',
        links: [
          { site: 'GitHub', url: 'https://github.com/johndoe' },
          { name: 'Twitter', link: 'https://twitter.com/johndoe' },
          'https://plainstring.example.com/johndoe',
          { irrelevant: 'no usable field' },
        ],
      }]),
    };
  });
  const doneObjLinks = await sherlock.pollRun({ runId: 'run-abc-123' });
  check('object-shaped links never surface as "[object Object]"',
    doneObjLinks.links.every((l) => !/\[object/i.test(l)));
  check('object-shaped links are flattened to readable "site: url" strings',
    doneObjLinks.links.includes('GitHub: https://github.com/johndoe')
    && doneObjLinks.links.includes('Twitter: https://twitter.com/johndoe'));
  check('a plain string link passes through unchanged',
    doneObjLinks.links.includes('https://plainstring.example.com/johndoe'));
  check('a link object with no usable field is dropped, not kept as garbage',
    doneObjLinks.links.length === 3);

  // ── pollRun: terminal failures are reported plainly, not as "no accounts found" ──
  for (const status of ['FAILED', 'ABORTED', 'TIMED-OUT']) {
    mockFetch(async () => ({ ok: true, json: async () => ({ data: { id: 'x', status } }) }));
    // eslint-disable-next-line no-await-in-loop
    const failed = await sherlock.pollRun({ runId: 'x' });
    check(`a ${status} run is reported as a failure, not an empty success`, failed.status === 'failed' && !!failed.error);
  }

  // ── pollRun: bad input never reaches the network ─────────────────────
  let pollCalls = 0;
  mockFetch(async () => { pollCalls++; throw new Error('should not fetch'); });
  const badPoll = await sherlock.pollRun({ runId: '' });
  check('an empty run id is rejected without a network call', !!badPoll.error && pollCalls === 0);

  // ── pollRun: network failure fails soft ──────────────────────────────
  mockFetch(async () => { throw new Error('network down'); });
  let threw = false;
  try { await sherlock.pollRun({ runId: 'run-abc-123' }); } catch { threw = true; }
  check('a network exception is caught, not left to throw out of pollRun()', !threw);

  restore();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
