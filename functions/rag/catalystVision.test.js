// Catalyst QuickML VLM endpoint client, mocked so this suite runs offline and
// fast. Run: node functions/rag/catalystVision.test.js
//
// The wire format asserted here (multipart image_files + prompt, the
// catalyst-org / x-quickml-endpoint-key headers, the {response} reply shape,
// the self-client refresh_token grant) was confirmed against the live
// endpoint and a real Zoho OAuth exchange, not assumed — see catalystVision.js's
// header comment. These tests lock that contract in so a future edit that
// drifts from it fails loudly instead of silently sending a malformed request.

const catalystVision = require('./catalystVision');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const originalFetch = global.fetch;
const ENV_KEYS = ['QUICKML_KEY_VLM', 'VLM_CLIENT_ID', 'VLM_CLIENT_SECRET', 'VLM_REFRESH_TOKEN'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function mockFetch(handler) { global.fetch = handler; }
function restore() {
  global.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  catalystVision._resetTokenCache();
}
function setEnv() {
  process.env.QUICKML_KEY_VLM = 'test-endpoint-key';
  process.env.VLM_CLIENT_ID = 'test-client-id';
  process.env.VLM_CLIENT_SECRET = 'test-client-secret';
  process.env.VLM_REFRESH_TOKEN = 'test-refresh-token';
  catalystVision._resetTokenCache();
}

const REAL_SHAPE_RESPONSE = {
  request_id: '9dcddcf2e5ef7f71',
  model: 'Qwen3.6-35B-A3B-FP8',
  response: 'The photo shows a seized motorcycle, registration partly visible.',
  metrics: { input_text_token_length: 400, output_text_token_length: 20, total_time_taken: 1.2 },
};
const TOKEN_RESPONSE = { access_token: 'fresh-access-token', expires_in: 3600, token_type: 'Bearer' };

const routedFetch = (routes) => async (url, opts) => {
  const key = String(url).startsWith(catalystVision.TOKEN_URL) ? 'token' : 'vlm';
  return routes[key](url, opts);
};

const smallImage = Buffer.from('fake-jpeg-bytes');

(async () => {
  setEnv();

  // ── Guard clauses — none of these should touch the network ───────────────
  let fetchCalls = 0;
  mockFetch(async () => { fetchCalls++; throw new Error('should not be called'); });

  delete process.env.QUICKML_KEY_VLM;
  check('no endpoint key configured returns null without a network call',
    (await catalystVision.callCatalystVLM(smallImage, 'image/jpeg', 'describe it')) === null);
  process.env.QUICKML_KEY_VLM = 'test-endpoint-key';

  check('an empty buffer returns null without a network call',
    (await catalystVision.callCatalystVLM(Buffer.alloc(0), 'image/jpeg', 'describe it')) === null);

  check('a non-buffer image returns null without a network call',
    (await catalystVision.callCatalystVLM('not-a-buffer', 'image/jpeg', 'describe it')) === null);

  const oversized = Buffer.alloc(catalystVision.MAX_IMAGE_BYTES + 1);
  check('an oversized image is skipped, not sent',
    (await catalystVision.callCatalystVLM(oversized, 'image/jpeg', 'describe it')) === null);

  check('an unsupported mime type returns null without a network call',
    (await catalystVision.callCatalystVLM(smallImage, 'image/gif', 'describe it')) === null);

  check('none of the guard clauses touched the network', fetchCalls === 0);

  // ── Missing self-client credentials ───────────────────────────────────────
  mockFetch(async () => { fetchCalls++; throw new Error('should not be called'); });
  delete process.env.VLM_REFRESH_TOKEN;
  check('missing refresh token returns null rather than throwing',
    (await catalystVision.callCatalystVLM(smallImage, 'image/jpeg', 'describe it')) === null);
  process.env.VLM_REFRESH_TOKEN = 'test-refresh-token';

  // ── Token exchange failure ────────────────────────────────────────────────
  catalystVision._resetTokenCache();
  mockFetch(routedFetch({
    token: async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_client' }) }),
    vlm: async () => { throw new Error('should not reach the VLM endpoint'); },
  }));
  check('a failed token exchange returns null and never calls the VLM endpoint',
    (await catalystVision.callCatalystVLM(smallImage, 'image/jpeg', 'describe it')) === null);

  // ── The real request shape, including the refresh_token grant ────────────
  catalystVision._resetTokenCache();
  let tokenReq, vlmUrl, vlmOpts, vlmForm;
  mockFetch(routedFetch({
    token: async (url, opts) => { tokenReq = opts; return { ok: true, status: 200, json: async () => TOKEN_RESPONSE }; },
    vlm: async (url, opts) => {
      vlmUrl = url; vlmOpts = opts; vlmForm = opts.body;
      return { ok: true, status: 200, json: async () => REAL_SHAPE_RESPONSE };
    },
  }));
  const answer = await catalystVision.callCatalystVLM(smallImage, 'image/jpeg', 'What does this photo show?');

  const tokenBody = new URLSearchParams(tokenReq.body);
  check('the token exchange uses grant_type=refresh_token', tokenBody.get('grant_type') === 'refresh_token');
  check('the token exchange carries the configured client id/secret/refresh token',
    tokenBody.get('client_id') === 'test-client-id'
    && tokenBody.get('client_secret') === 'test-client-secret'
    && tokenBody.get('refresh_token') === 'test-refresh-token');

  check('the endpoint URL is the confirmed VLM generate endpoint', vlmUrl === catalystVision.VLM_URL);
  check('the request is POST', vlmOpts.method === 'POST');
  check('the Authorization header carries the minted Zoho-oauthtoken bearer',
    vlmOpts.headers.Authorization === 'Zoho-oauthtoken fresh-access-token');
  check('the catalyst-org header is set', !!vlmOpts.headers['catalyst-org']);
  check('the x-quickml-endpoint-key header carries the configured key',
    vlmOpts.headers['x-quickml-endpoint-key'] === 'test-endpoint-key');
  check('no Content-Type is set manually (FormData sets its own boundary)',
    vlmOpts.headers['Content-Type'] === undefined && vlmOpts.headers['content-type'] === undefined);
  check('the body is a FormData instance, not JSON', vlmForm instanceof FormData);
  check('the prompt field is present in the form', vlmForm.get('prompt') === 'What does this photo show?');
  check('the image_files field is present in the form', vlmForm.get('image_files') != null);
  check('the parsed answer comes from the response field', answer === REAL_SHAPE_RESPONSE.response);

  // ── The token is cached — a second call must not hit the token endpoint ──
  let tokenCalls = 0, vlmCalls = 0;
  mockFetch(routedFetch({
    token: async () => { tokenCalls++; return { ok: true, status: 200, json: async () => TOKEN_RESPONSE }; },
    vlm: async () => { vlmCalls++; return { ok: true, status: 200, json: async () => REAL_SHAPE_RESPONSE }; },
  }));
  await catalystVision.callCatalystVLM(smallImage, 'image/jpeg', 'second question');
  check('a cached, unexpired token is reused rather than re-fetched', tokenCalls === 0 && vlmCalls === 1);

  // ── HTTP and payload failures degrade to null, never throw ───────────────
  mockFetch(routedFetch({
    token: async () => ({ ok: true, status: 200, json: async () => TOKEN_RESPONSE }),
    vlm: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  }));
  check('a non-2xx VLM response returns null',
    (await catalystVision.callCatalystVLM(smallImage, 'image/jpeg', 'x')) === null);

  mockFetch(routedFetch({
    token: async () => ({ ok: true, status: 200, json: async () => TOKEN_RESPONSE }),
    vlm: async () => ({ ok: true, status: 200, json: async () => ({ request_id: 'x' }) }),
  }));
  check('a response missing the response field returns null, not a crash',
    (await catalystVision.callCatalystVLM(smallImage, 'image/jpeg', 'x')) === null);

  mockFetch(routedFetch({
    token: async () => ({ ok: true, status: 200, json: async () => TOKEN_RESPONSE }),
    vlm: async () => { throw new Error('network down'); },
  }));
  check('a network error returns null rather than throwing',
    (await catalystVision.callCatalystVLM(smallImage, 'image/jpeg', 'x')) === null);

  restore();
  console.log(fail ? `\n${fail} FAILED, ${pass} passed.` : `\nAll ${pass} catalystVision checks passed.`);
  process.exit(fail ? 1 : 0);
})();
