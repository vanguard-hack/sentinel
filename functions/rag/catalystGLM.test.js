// Catalyst QuickML GLM-4.7-FLASH provider, mocked so this suite runs offline
// and fast. Run: node functions/rag/catalystGLM.test.js
//
// The wire format asserted here (JSON { prompt }, the catalyst-org /
// x-quickml-endpoint-key headers, the { data: [{ data }] } reply shape) was
// confirmed against the live endpoint, not assumed — see catalystGLM.js's
// header comment. Token-exchange behaviour is shared with catalystVision.js
// (same self-client, same cache), so those specifics are that module's own
// test file's job, not duplicated here.

const catalystVision = require('./catalystVision');
const catalystGLM = require('./catalystGLM');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const originalFetch = global.fetch;
const ENV_KEYS = ['QUICKML_KEY_GLM', 'VLM_CLIENT_ID', 'VLM_CLIENT_SECRET', 'VLM_REFRESH_TOKEN'];
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
  process.env.QUICKML_KEY_GLM = 'test-glm-key';
  process.env.VLM_CLIENT_ID = 'test-client-id';
  process.env.VLM_CLIENT_SECRET = 'test-client-secret';
  process.env.VLM_REFRESH_TOKEN = 'test-refresh-token';
  catalystVision._resetTokenCache();
}

// The real shape a live call returned: answer at data[0].data, not a
// top-level field like the VLM endpoint's `response`.
const REAL_SHAPE_RESPONSE = {
  data: [{ data: 'Hello. How can I assist you today?' }],
  usage: { prompt_tokens: 12, total_tokens: 22, completion_tokens: 10, prompt_tokens_details: null },
  model: 'crm-di-glm47b_30b_it',
  finish_reason: 'stop',
};
const TOKEN_RESPONSE = { access_token: 'fresh-access-token', expires_in: 3600, token_type: 'Bearer' };

const routedFetch = (routes) => async (url, opts) => {
  const key = String(url).startsWith(catalystVision.TOKEN_URL) ? 'token' : 'glm';
  return routes[key](url, opts);
};

const messages = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'wadap' },
];

(async () => {
  setEnv();

  // ── toPrompt: the OpenAI-shaped messages -> flat transcript conversion ────
  check('system content leads, unlabelled',
    catalystGLM.toPrompt([{ role: 'system', content: 'Be terse.' }]).startsWith('Be terse.'));
  check('a user turn is labelled',
    catalystGLM.toPrompt([{ role: 'user', content: 'hi' }]).includes('User: hi'));
  check('an assistant turn is labelled',
    catalystGLM.toPrompt([{ role: 'assistant', content: 'hello' }]).includes('Assistant: hello'));
  check('the transcript ends with a bare Assistant: cue',
    catalystGLM.toPrompt(messages).endsWith('\n\nAssistant:'));
  check('empty/no messages produce nothing but the cue',
    catalystGLM.toPrompt([]) === 'Assistant:');

  // ── Guard clauses — none of these should touch the network ───────────────
  let fetchCalls = 0;
  mockFetch(async () => { fetchCalls++; throw new Error('should not be called'); });

  delete process.env.QUICKML_KEY_GLM;
  check('no endpoint key configured returns null without a network call',
    (await catalystGLM.callCatalystGLM(messages)) === null);
  process.env.QUICKML_KEY_GLM = 'test-glm-key';

  check('no usable messages returns null without a network call',
    (await catalystGLM.callCatalystGLM([])) === null);
  check('messages with only empty content return null without a network call',
    (await catalystGLM.callCatalystGLM([{ role: 'user', content: '' }])) === null);

  check('none of the guard clauses touched the network', fetchCalls === 0);

  // ── Token exchange failure ────────────────────────────────────────────────
  catalystVision._resetTokenCache();
  mockFetch(routedFetch({
    token: async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_client' }) }),
    glm: async () => { throw new Error('should not reach the GLM endpoint'); },
  }));
  check('a failed token exchange returns null and never calls the GLM endpoint',
    (await catalystGLM.callCatalystGLM(messages)) === null);

  // ── The real request shape ────────────────────────────────────────────────
  catalystVision._resetTokenCache();
  let glmUrl, glmOpts, glmBody;
  mockFetch(routedFetch({
    token: async () => ({ ok: true, status: 200, json: async () => TOKEN_RESPONSE }),
    glm: async (url, opts) => {
      glmUrl = url; glmOpts = opts; glmBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => REAL_SHAPE_RESPONSE };
    },
  }));
  const answer = await catalystGLM.callCatalystGLM(messages);

  check('the endpoint URL is the confirmed GLM generate endpoint', glmUrl === catalystGLM.GLM_URL);
  check('the request is POST', glmOpts.method === 'POST');
  check('the Authorization header carries the minted Zoho-oauthtoken bearer',
    glmOpts.headers.Authorization === 'Zoho-oauthtoken fresh-access-token');
  check('the catalyst-org header is set', !!glmOpts.headers['catalyst-org']);
  check('the x-quickml-endpoint-key header carries the configured key',
    glmOpts.headers['x-quickml-endpoint-key'] === 'test-glm-key');
  check('the body is JSON, not multipart (unlike the VLM endpoint)',
    typeof glmOpts.body === 'string');
  check('the body carries one flat prompt field, not a messages array',
    typeof glmBody.prompt === 'string' && glmBody.messages === undefined);
  check('the prompt folds in both the system and user turns',
    glmBody.prompt.includes('You are terse.') && glmBody.prompt.includes('User: wadap'));
  check('the parsed answer comes from data[0].data, not a top-level field',
    answer === REAL_SHAPE_RESPONSE.data[0].data);

  // ── HTTP and payload failures degrade to null, never throw ───────────────
  mockFetch(routedFetch({
    token: async () => ({ ok: true, status: 200, json: async () => TOKEN_RESPONSE }),
    glm: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  }));
  check('a non-2xx GLM response returns null',
    (await catalystGLM.callCatalystGLM(messages)) === null);

  mockFetch(routedFetch({
    token: async () => ({ ok: true, status: 200, json: async () => TOKEN_RESPONSE }),
    glm: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
  }));
  check('a response with an empty data array returns null, not a crash',
    (await catalystGLM.callCatalystGLM(messages)) === null);

  mockFetch(routedFetch({
    token: async () => ({ ok: true, status: 200, json: async () => TOKEN_RESPONSE }),
    glm: async () => { throw new Error('network down'); },
  }));
  check('a network error returns null rather than throwing',
    (await catalystGLM.callCatalystGLM(messages)) === null);

  restore();
  console.log(fail ? `\n${fail} FAILED, ${pass} passed.` : `\nAll ${pass} catalystGLM checks passed.`);
  process.exit(fail ? 1 : 0);
})();
