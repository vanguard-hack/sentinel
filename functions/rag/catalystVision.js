'use strict';

// Qwen3.6-35B-A3B VLM, deployed as a Catalyst QuickML "vision model endpoint"
// in the IN data center. This is a genuine LLM call with real per-call cost —
// unlike vision.js's OCR/objects/barcode/moderation pass, which is cheap and
// runs on every attach, this is invoked only when the officer's actual
// question needs visual understanding OCR text can't provide. See
// needsVisualAnalysis() in index.js for that decision; this module only
// knows how to make the call.
//
// The wire format was confirmed against the live endpoint (Console → the
// endpoint's own "Model Details → API Details" sample, then verified with a
// real request/response round trip) rather than assumed from generic docs,
// which for this specific product were stale and incomplete:
//   • multipart/form-data, NOT an OpenAI-style JSON messages body — fields
//     are `image_files` (the image) and `prompt` (one flat string; there is
//     no separate system-prompt field, so callers fold instructions and the
//     officer's question into one string before calling this).
//   • auth is a Zoho-oauthtoken bearer PLUS a catalyst-org header (the org
//     id, not the project id — confirmed off the real request; project id
//     is already in the URL) PLUS a per-endpoint x-quickml-endpoint-key
//     header.
//   • temperature/top_p/top_k/max_tokens are NOT request parameters — they
//     are configured on the endpoint in Console at deploy time.
//   • response is { request_id, model, response, metrics }.
//
// Auth is a self-client refresh-token flow, not Catalyst's Connections
// feature — Connections' "Catalyst by Zoho" default connector routes through
// a shared, pre-registered client (its OAuth redirect targets Deluge's own
// callback) whose allowed-scope list doesn't yet include this endpoint's
// scope, so every grant attempt through it fails "Invalid OAuth Scope"
// regardless of how the scope string is spelled. A dedicated self-client —
// registered at api-console.zoho.in with exactly the scope this endpoint
// needs, nothing shared with any other integration — sidesteps that gap
// entirely and is also the least-privilege choice: it can be revoked on its
// own without touching whatever the project's other Zoho credentials cover.

const VLM_URL =
  'https://console.catalyst.zoho.in/quickml/v1/project/49826000000024269/genai/endpoints/vlm/generate';
const TOKEN_URL = 'https://accounts.zoho.in/oauth/v2/token';
const FETCH_TIMEOUT_MS = 18_000;
const TOKEN_TIMEOUT_MS = 10_000;

// The Java SDK's docs for this endpoint type state a 500KB cap; unconfirmed
// for this specific deployment (the live capture used to verify the wire
// format above sent an empty file, so it never actually tested the limit).
// Enforced here as a safety margin — a skipped VLM call degrades gracefully
// to OCR-only context, which is a much better failure than finding the real
// limit via a production 4xx on an officer's evidence photo.
const MAX_IMAGE_BYTES = 500 * 1024;

const ORG_ID = process.env.RAG_ORG || '60073599957';

// In-memory cache for the access token this refresh_token mints — a module-
// level singleton is fine here, same as callClaude's cached client: one
// function instance, one credential, no per-request identity to key on.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

/**
 * Mint (or reuse) an access token from the dedicated VLM self-client's
 * refresh token. Refreshes ~2 minutes before the token's stated expiry
 * rather than waiting for a 401, and never throws — a failure here just
 * means the VLM pass is skipped, same as every other failure mode in this
 * module.
 */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) return cachedToken;

  const clientId = process.env.VLM_CLIENT_ID;
  const clientSecret = process.env.VLM_CLIENT_SECRET;
  const refreshToken = process.env.VLM_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`catalystVision: token refresh failed — HTTP ${res.status}`);
      return null;
    }
    const data = await res.json().catch(() => null);
    if (!data || !data.access_token) return null;
    cachedToken = data.access_token;
    cachedTokenExpiresAt = now + Math.max(60, (Number(data.expires_in) || 3600) - 120) * 1000;
    return cachedToken;
  } catch (e) {
    console.warn('catalystVision: token refresh errored —', (e && e.message) || e);
    return null;
  }
}

/**
 * Ask the Qwen VLM endpoint about one image.
 *
 * `prompt` is the complete text to send — system instructions and the
 * officer's question already combined by the caller, since the endpoint has
 * no separate field for them.
 *
 * Returns the model's answer text, or null for anything that stops it from
 * answering: missing config, an oversized image, a token failure, a network
 * or HTTP failure. Never throws — callers treat null exactly like a missed
 * Groq/Claude call and carry on without this context rather than failing
 * the whole answer.
 */
async function callCatalystVLM(imageBuffer, mime, prompt, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const endpointKey = process.env.QUICKML_KEY_VLM;
  if (!endpointKey) return null;
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return null;
  if (imageBuffer.length > MAX_IMAGE_BYTES) {
    console.warn(`catalystVision: image too large for the VLM endpoint (${imageBuffer.length} bytes) — skipped`);
    return null;
  }
  if (!/^image\/(jpeg|png)$/.test(mime)) return null;

  const token = await getAccessToken();
  if (!token) return null;

  try {
    const form = new FormData();
    const ext = mime === 'image/png' ? 'png' : 'jpg';
    form.append('image_files', new Blob([imageBuffer], { type: mime }), `attachment.${ext}`);
    form.append('prompt', String(prompt || '').slice(0, 4000));

    const res = await fetch(VLM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'catalyst-org': ORG_ID,
        'x-quickml-endpoint-key': endpointKey,
      },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`catalystVision: VLM call failed — HTTP ${res.status}`);
      return null;
    }
    const data = await res.json().catch(() => null);
    const text = data && typeof data.response === 'string' ? data.response.trim() : '';
    return text || null;
  } catch (e) {
    console.warn('catalystVision: VLM call errored —', (e && e.message) || e);
    return null;
  }
}

// Test-only: clears the cached token so each test starts from a clean slate.
function _resetTokenCache() {
  cachedToken = null;
  cachedTokenExpiresAt = 0;
}

module.exports = {
  callCatalystVLM, getAccessToken, VLM_URL, TOKEN_URL, MAX_IMAGE_BYTES, _resetTokenCache,
};
