'use strict';

/**
 * Bhashini — the Government of India language stack (MeitY, National Language
 * Translation Mission), reached through ULCA.
 *
 * WHY THIS AND NOT ANOTHER CLOUD
 *
 * Sentinel's rule is that police content does not leave the country. Zia keeps
 * that promise by living in Zoho's Indian data centre, and it does support
 * Kannada — but its Indic models are a black box we cannot evaluate, and the
 * alternatives that are demonstrably better at Kannada (Google, Azure, Adobe)
 * all break the rule.
 *
 * Bhashini is the exception: Indic models built for exactly these languages,
 * run on Indian government infrastructure, free. It is the only provider on the
 * table that improves quality WITHOUT weakening the data-residency position —
 * which is the reason it is here, ahead of any benchmark.
 *
 * HOW ULCA WORKS, AND WHY IT IS TWO CALLS
 *
 * Bhashini does not host one endpoint per task. A pipeline is CONFIGURED first
 * — "I want ASR in Kannada" — and that call returns the specific inference
 * endpoint and a request-scoped key to use for it. Only then does the audio or
 * text get sent. Two round trips, so the configuration is cached per task and
 * language for the life of the container.
 *
 * WHAT HAPPENS WITHOUT CREDENTIALS
 *
 * Nothing breaks. `available()` returns false, every entry point returns null,
 * and callers fall through to the Zia path they use today. That is deliberate:
 * this must be an upgrade a deployment can choose, never a dependency that
 * turns an unconfigured environment into a broken one.
 *
 * SET UP
 *   BHASHINI_USER_ID     — from the ULCA dashboard
 *   BHASHINI_API_KEY     — the ULCA API key
 *   BHASHINI_PIPELINE_ID — optional; defaults to the public MeitY pipeline
 */

const AUTH_URL = 'https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline';
// The publicly documented MeitY pipeline. Overridable because pipeline ids are
// registry entries, not constants of nature, and a redeploy is a poor reason to
// be locked out of a language.
const DEFAULT_PIPELINE = '64392f96daac500b55c543cd';

// Bhashini speaks ISO-639-1. Sentinel's UI and Zia use their own codes, so the
// mapping is explicit rather than assumed — 'kan' is Zia's Kannada and 'kn' is
// Bhashini's, and quietly sending one for the other fails as "language not
// supported" with nothing to say why.
const LANG = { en: 'en', eng: 'en', kn: 'kn', kan: 'kn', hi: 'hi', hin: 'hi' };
const toBhashini = (code) => LANG[String(code || '').slice(0, 3).toLowerCase()]
  || LANG[String(code || '').slice(0, 2).toLowerCase()]
  || null;

const cfg = () => ({
  userId: process.env.BHASHINI_USER_ID || '',
  apiKey: process.env.BHASHINI_API_KEY || '',
  pipeline: process.env.BHASHINI_PIPELINE_ID || DEFAULT_PIPELINE,
});

/** Is this deployment configured to use Bhashini at all? */
const available = () => {
  const c = cfg();
  return !!(c.userId && c.apiKey);
};

// One cache per container, keyed by task and language pair. Pipelines are
// stable; re-configuring on every voice note would double the latency of the
// slowest thing an officer waits for.
const pipelines = new Map();

/**
 * Ask ULCA which endpoint serves this task in this language.
 *
 * `fetchImpl` is injectable so the tests can exercise the two-step dance and
 * every way it fails without a network or credentials.
 */
async function configure(taskType, source, target, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!available()) return null;
  const key = `${taskType}:${source}:${target || ''}`;
  if (pipelines.has(key)) return pipelines.get(key);

  const c = cfg();
  const language = target ? { sourceLanguage: source, targetLanguage: target } : { sourceLanguage: source };

  let data;
  try {
    const res = await fetchImpl(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', userID: c.userId, ulcaApiKey: c.apiKey },
      body: JSON.stringify({
        pipelineTasks: [{ taskType, config: { language } }],
        pipelineRequestConfig: { pipelineId: c.pipeline },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }

  const endpoint = data && data.pipelineInferenceAPIEndPoint;
  const serviceId = data
    && Array.isArray(data.pipelineResponseConfig)
    && data.pipelineResponseConfig[0]
    && Array.isArray(data.pipelineResponseConfig[0].config)
    && data.pipelineResponseConfig[0].config[0]
    && data.pipelineResponseConfig[0].config[0].serviceId;

  if (!endpoint || !endpoint.callbackUrl || !endpoint.inferenceApiKey || !serviceId) return null;

  const resolved = {
    url: endpoint.callbackUrl,
    headerName: endpoint.inferenceApiKey.name,
    headerValue: endpoint.inferenceApiKey.value,
    serviceId,
    // Only meaningful for ASR, and absent for everything else.
    samplingRate: (data.pipelineResponseConfig[0].config[0].modelProcessingType
      && data.pipelineResponseConfig[0].config[0].modelProcessingType.type) === 'streaming' ? 16000 : 16000,
  };
  pipelines.set(key, resolved);
  return resolved;
}

/** Run the configured pipeline. Returns the raw ULCA response, or null. */
async function compute(pipeline, taskType, config, inputPayload, { fetchImpl = fetch, timeoutMs = 45_000 } = {}) {
  try {
    const res = await fetchImpl(pipeline.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [pipeline.headerName]: pipeline.headerValue },
      body: JSON.stringify({
        pipelineTasks: [{ taskType, config }],
        inputData: inputPayload,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const firstOutput = (data, field) => {
  const task = data && Array.isArray(data.pipelineResponse) && data.pipelineResponse[0];
  const out = task && Array.isArray(task.output) && task.output[0];
  return out && typeof out[field] === 'string' ? out[field] : '';
};

/**
 * Speech to text.
 *
 * `audioBase64` is the raw recording, already base64 — Bhashini takes it inline
 * rather than as a multipart upload. Returns null on anything at all going
 * wrong, because the caller's fallback is a working transcription service and
 * an error here should cost the officer nothing but a few hundred milliseconds.
 */
async function transcribe(audioBase64, language, opts = {}) {
  const lang = toBhashini(language);
  if (!lang || !audioBase64) return null;
  const pipeline = await configure('asr', lang, null, opts);
  if (!pipeline) return null;

  const data = await compute(
    pipeline,
    'asr',
    {
      language: { sourceLanguage: lang },
      serviceId: pipeline.serviceId,
      audioFormat: opts.audioFormat || 'wav',
      samplingRate: opts.samplingRate || pipeline.samplingRate,
    },
    { audio: [{ audioContent: audioBase64 }] },
    opts,
  );
  const text = firstOutput(data, 'source');
  return text ? { text, language: lang, provider: 'bhashini' } : null;
}

/**
 * Translate between Indian languages and English.
 *
 * Useful in both directions and for different reasons: a Kannada statement an
 * English-reading officer has to work from, and an English finding a Kannada-
 * speaking constable has to act on.
 */
async function translate(text, from, to, opts = {}) {
  const src = toBhashini(from);
  const tgt = toBhashini(to);
  if (!src || !tgt || src === tgt || !String(text || '').trim()) return null;
  const pipeline = await configure('translation', src, tgt, opts);
  if (!pipeline) return null;

  const data = await compute(
    pipeline,
    'translation',
    { language: { sourceLanguage: src, targetLanguage: tgt }, serviceId: pipeline.serviceId },
    { input: [{ source: String(text).slice(0, 5000) }] },
    opts,
  );
  const out = firstOutput(data, 'target');
  return out ? { text: out, from: src, to: tgt, provider: 'bhashini' } : null;
}

/** For tests, and for a deployment that rotates its key without a restart. */
const _reset = () => pipelines.clear();

module.exports = {
  available, configure, compute, transcribe, translate, toBhashini,
  AUTH_URL, DEFAULT_PIPELINE, LANG, _reset,
};
