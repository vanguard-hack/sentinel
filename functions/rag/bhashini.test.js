// Bhashini / ULCA. Run: node functions/rag/bhashini.test.js
//
// This integration cannot be exercised against the real service without ULCA
// credentials, so what is tested is everything that decides whether an officer
// is affected by it: that an unconfigured deployment behaves exactly as it did
// before, that every failure returns null rather than throwing, and that the
// two-step pipeline dance sends what ULCA expects.
//
// The second of those is the one that matters most. This sits in front of a
// working transcription service, so ANY way it can fail has to end with the
// caller falling through — a new integration that turns a bad minute at a
// government API into a broken voice note has made the product worse.
const bhashini = require('./bhashini');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const withEnv = async (env, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
    bhashini._reset();
  }
};

const CONFIGURED = { BHASHINI_USER_ID: 'u-1', BHASHINI_API_KEY: 'k-1' };

// A stub standing in for both ULCA calls, recording what it was sent.
const stub = (overrides = {}) => {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    if (url === bhashini.AUTH_URL) {
      if (overrides.authFails) return { ok: false, status: 500 };
      if (overrides.authThrows) throw new Error('network down');
      if (overrides.authMalformed) return { ok: true, json: async () => ({ nothing: true }) };
      return {
        ok: true,
        json: async () => ({
          pipelineInferenceAPIEndPoint: {
            callbackUrl: 'https://inference.example/compute',
            inferenceApiKey: { name: 'Authorization', value: 'secret-token' },
          },
          pipelineResponseConfig: [{ config: [{ serviceId: 'svc-asr-kn' }] }],
        }),
      };
    }
    if (overrides.computeFails) return { ok: false, status: 502 };
    if (overrides.computeThrows) throw new Error('timeout');
    return {
      ok: true,
      json: async () => ({
        pipelineResponse: [{
          output: [{ source: overrides.text ?? 'ಆರೋಪಿ ಓಡಿಹೋದನು', target: overrides.target ?? 'The accused ran away' }],
        }],
      }),
    };
  };
  return { impl, calls };
};

(async () => {
  // ── Unconfigured: the deployment must behave as it did before ───────────
  bhashini._reset();
  check('an unconfigured deployment reports itself unavailable', bhashini.available() === false);
  check('  and transcription returns null rather than throwing',
    (await bhashini.transcribe('AAAA', 'kn')) === null);
  check('  and translation too', (await bhashini.translate('hello', 'en', 'kn')) === null);
  check('  and configure declines', (await bhashini.configure('asr', 'kn')) === null);

  // ── Language codes ──────────────────────────────────────────────────────
  check('Zia\'s three-letter codes map to ULCA\'s two',
    bhashini.toBhashini('kan') === 'kn' && bhashini.toBhashini('hin') === 'hi'
    && bhashini.toBhashini('eng') === 'en');
  check('the UI\'s own codes map too',
    bhashini.toBhashini('kn') === 'kn' && bhashini.toBhashini('en') === 'en');
  check('a regional variant resolves', bhashini.toBhashini('kn-IN') === 'kn');
  check('an unsupported language is refused rather than guessed',
    bhashini.toBhashini('fr') === null && bhashini.toBhashini('') === null
    && bhashini.toBhashini(null) === null);

  // ── The happy path, and what it sends ───────────────────────────────────
  await withEnv(CONFIGURED, async () => {
    check('a configured deployment reports itself available', bhashini.available() === true);

    const s = stub();
    const out = await bhashini.transcribe('BASE64AUDIO', 'kan', { fetchImpl: s.impl });
    check('a Kannada recording comes back transcribed', out && out.text === 'ಆರೋಪಿ ಓಡಿಹೋದನು', JSON.stringify(out));
    check('  and says which provider answered', out && out.provider === 'bhashini');

    check('it is two calls: configure, then compute', s.calls.length === 2, String(s.calls.length));
    const [auth, comp] = s.calls;
    check('the config call carries the ULCA credentials as headers',
      auth.headers.userID === 'u-1' && auth.headers.ulcaApiKey === 'k-1');
    check('  and asks for ASR in the right language',
      auth.body.pipelineTasks[0].taskType === 'asr'
      && auth.body.pipelineTasks[0].config.language.sourceLanguage === 'kn');
    check('  using the configured pipeline id',
      auth.body.pipelineRequestConfig.pipelineId === bhashini.DEFAULT_PIPELINE);
    check('the compute call goes to the endpoint the config returned',
      comp.url === 'https://inference.example/compute');
    check('  with the request-scoped key under the header name ULCA named',
      comp.headers.Authorization === 'secret-token');
    check('  carrying the service id the config chose',
      comp.body.pipelineTasks[0].config.serviceId === 'svc-asr-kn');
    check('  and the audio inline as base64',
      comp.body.inputData.audio[0].audioContent === 'BASE64AUDIO');

    // The pipeline is cached, or every voice note pays for two round trips.
    const s2 = stub();
    await bhashini.transcribe('MORE', 'kan', { fetchImpl: s2.impl });
    check('a second recording reuses the configured pipeline', s2.calls.length === 1,
      `${s2.calls.length} call(s)`);
  });

  // ── Translation ─────────────────────────────────────────────────────────
  await withEnv(CONFIGURED, async () => {
    const s = stub();
    const t = await bhashini.translate('ಆರೋಪಿ ಓಡಿಹೋದನು', 'kn', 'en', { fetchImpl: s.impl });
    check('Kannada translates to English', t && t.text === 'The accused ran away', JSON.stringify(t));
    check('  and the config call names both languages',
      s.calls[0].body.pipelineTasks[0].config.language.targetLanguage === 'en');
    check('translating a language into itself is refused as pointless',
      (await bhashini.translate('x', 'kn', 'kan', { fetchImpl: s.impl })) === null);
    check('empty text is refused before any call',
      (await bhashini.translate('   ', 'kn', 'en', { fetchImpl: s.impl })) === null);
  });

  // ── Every failure ends in null, never a throw ───────────────────────────
  for (const [name, over] of [
    ['the config call fails', { authFails: true }],
    ['the config call throws', { authThrows: true }],
    ['the config reply is malformed', { authMalformed: true }],
    ['the compute call fails', { computeFails: true }],
    ['the compute call throws', { computeThrows: true }],
    ['the transcript comes back empty', { text: '' }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await withEnv(CONFIGURED, async () => {
      const s = stub(over);
      let threw = false;
      let out = 'unset';
      try { out = await bhashini.transcribe('AUDIO', 'kn', { fetchImpl: s.impl }); }
      catch { threw = true; }
      check(`when ${name}, the caller gets null`, !threw && out === null,
        threw ? 'it threw' : JSON.stringify(out));
    });
  }

  // ── The caller falls through, which is the point ────────────────────────
  const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
  const handler = src.slice(src.indexOf('async function handleTranscribe'), src.indexOf('async function openExportHold'));
  check('transcription tries Bhashini only for Indian languages',
    /bhashini\.available\(\) && \['kn', 'hi'\]\.includes\(lang\)/.test(handler),
    'English gains nothing from a second service in a second data centre');
  check('  and returns the Zia path when Bhashini declines',
    handler.indexOf('const token = await getAccessToken();') > handler.indexOf('bhashini.available()'),
    'the fallback must come after, not instead');
  check('  with the failure logged rather than swallowed',
    /falling back to Zia/.test(handler));
  check('the health check reports whether it is configured',
    /bhashini: bhashini\.available\(\)/.test(src),
    'a deploy that cleared the key would otherwise downgrade Kannada silently');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
