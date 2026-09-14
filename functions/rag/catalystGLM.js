'use strict';

// GLM-4.7-FLASH (Zoho-hosted, model id "crm-di-glm47b_30b_it"), deployed as a
// Catalyst QuickML "genai" endpoint in the IN data center. This is the
// primary LLM provider in the callLLM chain — see PROVIDER_ORDER in
// index.js — with Groq and Claude as fallback if it is unconfigured, down,
// or returns nothing.
//
// Auth reuses the VLM endpoint's self-client refresh-token flow verbatim
// (catalystVision.getAccessToken): both endpoints are QuickML deployments
// under the same Catalyst project and both were confirmed to need exactly
// the scope QuickML.deployment.READ, so the same token authorizes both —
// no second self-client to register. The env var names still say VLM_* for
// that reason; they are the QuickML self-client's credentials, not
// anything specific to vision.
//
// The wire format was confirmed against the live endpoint (Console → the
// endpoint's own API Details panel, then a real request/response round
// trip) rather than assumed from generic docs:
//   • JSON body, one flat field: { "prompt": "..." } — no messages array,
//     no separate system field, so callLLM's OpenAI-shaped messages are
//     folded into one transcript string before calling this (toPrompt
//     below), the same approach VLM's callers already use for images.
//   • auth is a Zoho-oauthtoken bearer PLUS a catalyst-org header PLUS a
//     per-endpoint x-quickml-endpoint-key header — identical shape to VLM.
//   • temperature/max_tokens are NOT request parameters — configured on
//     the endpoint in Console at deploy time, same as VLM.
//   • response is { data: [{ data: "<answer text>" }], usage, model,
//     finish_reason } — the answer lives at data[0].data, not the VLM
//     endpoint's top-level `response` field. Confirmed from a live call;
//     not assumed to match VLM's shape just because the auth does.

const { getAccessToken } = require('./catalystVision');

const GLM_URL =
  'https://console.catalyst.zoho.in/quickml/v1/project/49826000000024269/genai/endpoints/glm-flash-47/generate';
const FETCH_TIMEOUT_MS = 12_000;
const ORG_ID = process.env.RAG_ORG || '60073599957';

// OpenAI-shaped messages -> one flat transcript. System content(s) lead,
// unlabelled (it is instructions, not a speaker turn); each user/assistant
// turn is labelled so the model can tell them apart in a single string. A
// trailing "Assistant:" cues a completion-style endpoint (no chat turns of
// its own) to continue as the assistant rather than echo or restate.
function toPrompt(messages) {
  const parts = [];
  for (const m of messages || []) {
    if (!m || !m.content) continue;
    if (m.role === 'system') { parts.push(String(m.content)); continue; }
    parts.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
  }
  parts.push('Assistant:');
  return parts.join('\n\n');
}

/**
 * Ask GLM-4.7-FLASH to continue an OpenAI-shaped conversation.
 *
 * Returns the model's answer text, or null for anything that stops it from
 * answering: missing config, no usable messages, a token failure, a network
 * or HTTP failure. Never throws — callLLM treats null exactly like a missed
 * Groq/Claude call and tries the next provider in PROVIDER_ORDER.
 */
async function callCatalystGLM(messages, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const endpointKey = process.env.QUICKML_KEY_GLM;
  if (!endpointKey) return null;

  const prompt = toPrompt(messages);
  if (!prompt || prompt === 'Assistant:') return null;

  const token = await getAccessToken();
  if (!token) return null;

  try {
    const res = await fetch(GLM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'catalyst-org': ORG_ID,
        'content-type': 'application/json; charset=UTF-8',
        'x-quickml-endpoint-key': endpointKey,
      },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`catalystGLM: call failed — HTTP ${res.status}`);
      return null;
    }
    const data = await res.json().catch(() => null);
    const text = data && Array.isArray(data.data) && data.data[0] && typeof data.data[0].data === 'string'
      ? data.data[0].data.trim()
      : '';
    return text || null;
  } catch (e) {
    console.warn('catalystGLM: call errored —', (e && e.message) || e);
    return null;
  }
}

module.exports = { callCatalystGLM, toPrompt, GLM_URL };
