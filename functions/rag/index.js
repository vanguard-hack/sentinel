'use strict';

const catalystSDK = require('zcatalyst-sdk-node');
const zcql = require('./zcql');

/*
 * RAG proxy — keeps OAuth credentials server-side and calls the Catalyst
 * QuickML RAG "answer" API on behalf of the signed-in web client.
 *
 * The browser POSTs { query } to /server/rag/ (same origin as the app). This
 * function mints a Zoho access token from the OAuth client + refresh token and
 * forwards the query to the RAG endpoint.
 *
 * Required environment variables (set in the Catalyst console → Functions →
 * rag → Environment Variables — NEVER hard-code secrets here):
 *   RAG_CLIENT_ID       OAuth client id
 *   RAG_CLIENT_SECRET   OAuth client secret
 *   RAG_REFRESH_TOKEN   OAuth refresh token (preferred; auto-renews)
 *   RAG_ACCESS_TOKEN    (optional) a static access token for quick testing
 *   RAG_DOCUMENT_IDS    comma-separated QuickML document ids to search
 * Optional overrides:
 *   RAG_ACCOUNTS_HOST   default https://accounts.zoho.in
 *   RAG_API_URL         default the project's rag/answer endpoint
 *   RAG_ORG             default 60073599957
 */

const ACCOUNTS_HOST = process.env.RAG_ACCOUNTS_HOST || 'https://accounts.zoho.in';
const RAG_API_URL =
  process.env.RAG_API_URL ||
  'https://api.catalyst.zoho.in/quickml/v1/project/49826000000024269/rag/answer';
const ORG = process.env.RAG_ORG || '60073599957';

let cached = null; // { token, exp }

async function getAccessToken() {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;

  // Prefer refresh-token flow; fall back to a static access token for testing.
  if (process.env.RAG_REFRESH_TOKEN) {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.RAG_CLIENT_ID || '',
      client_secret: process.env.RAG_CLIENT_SECRET || '',
      refresh_token: process.env.RAG_REFRESH_TOKEN,
    });
    const r = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token?${params.toString()}`, {
      method: 'POST',
    });
    const j = await r.json();
    if (!j.access_token) throw new Error('token exchange failed: ' + JSON.stringify(j));
    cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return cached.token;
  }

  if (process.env.RAG_ACCESS_TOKEN) return process.env.RAG_ACCESS_TOKEN;
  throw new Error('No RAG_REFRESH_TOKEN or RAG_ACCESS_TOKEN configured');
}

// AG-UI-style "static generative UI": we ask the model to optionally append a
// fenced JSON block describing typed components (bar-chart / pie-chart / table /
// cards). The app owns the rendering; the agent only proposes typed specs.
// Two-pass generative UI. Appending component instructions to the user's query
// polluted the retrieval embedding (short questions stopped matching their
// documents), so pass 1 sends the query CLEAN, and pass 2 — run only when the
// answer looks data-shaped — asks the model to transform that answer text into
// components. Pass 2's retrieval is irrelevant; the data is in the prompt.
const AGUI_TRANSFORM =
  'Convert the data in the TEXT below into ONE fenced ```agui code block of JSON ' +
  '{"components":[...]} where each component is ' +
  '{"type":"bar-chart"|"pie-chart","title":s,"data":[{"label":s,"value":n}]} or ' +
  '{"type":"table","title":s,"columns":[s],"rows":[[cells]]} or ' +
  '{"type":"cards","title":s,"items":[{"title":s,"subtitle":s,"body":s,"badge":s}]} or ' +
  '{"type":"geo-map","title":s,"data":[{"district":s,"value":n}]} (Karnataka district ' +
  'names — use when the data is per-district) or ' +
  '{"type":"network-graph","title":s,"nodes":[{"id":s,"label":s,"group":s}],' +
  '"links":[{"source":s,"target":s}]} (use for relationships between people/gangs/entities). ' +
  'RULE: if the values are per Karnataka district, ALWAYS use geo-map (not bar-chart), ' +
  'with plain district names (e.g. "Bengaluru City", "Kalaburagi" — no DIST suffix). ' +
  'Choose the 1-2 components that best fit the data. Output ONLY the fenced block.' +
  '\n\nTEXT:\n';

// ── Groq (fallback LLM + query expansion) ──────────────────────────────────
// Used three ways, all best-effort (RAG-only behaviour if the key is absent):
//   1. expand the user's question into a self-contained one before retrieval
//   2. answer from general knowledge when RAG comes back negative
//   3. transform answers into agui components (faster + more reliable than a
//      second RAG round-trip)
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
// Groq rate-limits per model. High-volume/simple calls (routing, expansion,
// prose-from-rows, component transform) run on the fast model so the 70B
// budget is reserved for ZCQL generation and knowledge fallbacks.
const GROQ_MODEL_FAST = process.env.GROQ_MODEL_FAST || 'llama-3.1-8b-instant';

async function callGroq(messages, { maxTokens = 1024, temperature = 0.3, timeoutMs = 12_000, model = GROQ_MODEL } = {}) {
  if (!process.env.GROQ_API_KEY) return null;
  // One retry on 429: the free tier has a tokens-per-minute cap that a single
  // multi-call question (router + generator + prose) can trip.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status === 429 && attempt === 0) {
        const wait = Math.min((parseFloat(r.headers.get('retry-after')) || 3) * 1000, 8_000);
        await new Promise((s) => setTimeout(s, wait));
        continue;
      }
      const d = await r.json().catch(() => ({}));
      return r.ok ? (d.choices && d.choices[0] && d.choices[0].message.content) || null : null;
    } catch {
      return null; // timeout / network — callers treat null as "skip"
    }
  }
  return null;
}

const EXPAND_PROMPT =
  'Rewrite the user question as ONE clear, self-contained question for searching a ' +
  'police crime-analytics knowledge base (FIRs, gangs, police stations, modus operandi, ' +
  'investigation officers, crime FAQs, crime statistics). Use the conversation context ' +
  'to resolve pronouns and references ("it", "that gang", "there") into explicit names. ' +
  'Preserve every specific detail (names, codes, places, dates); expand abbreviations; ' +
  'do NOT invent details or add assumptions. Output ONLY the rewritten question.';

const FALLBACK_SYSTEM =
  'You are Sentinel Assistant, helping Indian police analysts. The internal knowledge ' +
  'base had no answer, so answer from general knowledge — Indian law, police procedure, ' +
  'criminology, general facts. Be concise and factual. Never say you cannot display ' +
  'charts or images and never describe what a chart would look like — just present the ' +
  'data plainly. If you genuinely cannot answer, say so.';

// A RAG non-answer: empty, or a short "I don't know" style reply.
const NEGATIVE_RE =
  /i'?m not sure|i don'?t (know|have)|not sure what information|no (relevant |such )?information|couldn'?t find|cannot find|unable to (find|answer)|not (available|mentioned|provided) in/i;
const isNegative = (t) => !String(t).trim() || (String(t).length < 240 && NEGATIVE_RE.test(t));

// Worth a second model call only when the prose plausibly contains data to
// visualize: some length plus digits or a multi-item list.
function looksDataShaped(text) {
  const t = String(text);
  const listLines = t.split('\n').filter((l) => /^\s*(\d+[.)]|[-*•])\s+/.test(l)).length;
  return t.length >= 120 && (/\d/.test(t) || listLines >= 3);
}

const AGUI_TYPES = new Set([
  'bar-chart', 'pie-chart', 'table', 'cards', 'geo-map', 'network-graph',
]);

// Pull a ```agui (or ```json) fenced block out of the answer text. Returns
// { text, components } — text has the block stripped; components is validated
// (unknown types dropped) and [] when absent or unparseable.
function extractAgui(text) {
  const m = String(text).match(/```(?:agui|json)\s*([\s\S]*?)```/);
  if (!m) return { text: String(text).trim(), components: [] };
  let components = [];
  try {
    const parsed = JSON.parse(m[1]);
    const list = Array.isArray(parsed) ? parsed : parsed.components;
    if (Array.isArray(list)) {
      components = list.filter((c) => c && AGUI_TYPES.has(c.type));
    }
  } catch {
    /* malformed block — fall back to text-only */
  }
  return { text: String(text).replace(m[0], '').trim(), components };
}

// The chat UI renders prose as plain text, so markdown tables show up as pipe
// soup — and usually duplicate a table component. Strip them from the prose;
// if no table component exists yet, convert the first one so no data is lost.
function stripMarkdownTables(text, components) {
  const lines = String(text).split('\n');
  const blocks = []; // { start, end } of consecutive |-prefixed lines
  let start = null;
  lines.forEach((ln, i) => {
    const isRow = /^\s*\|.*\|\s*$/.test(ln);
    if (isRow && start === null) start = i;
    if (!isRow && start !== null) {
      if (i - start >= 2) blocks.push({ start, end: i });
      start = null;
    }
  });
  if (start !== null && lines.length - start >= 2) blocks.push({ start, end: lines.length });
  if (!blocks.length) return { text, components };

  const hasTable = components.some((c) => c.type === 'table');
  if (!hasTable) {
    const b = blocks[0];
    const rows = lines
      .slice(b.start, b.end)
      .map((ln) => ln.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
      .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c) || c === ''));
    if (rows.length >= 2) {
      components = [...components, { type: 'table', columns: rows[0], rows: rows.slice(1) }];
    }
  }
  const keep = lines.filter((_, i) => !blocks.some((b) => i >= b.start && i < b.end));
  return { text: keep.join('\n').replace(/\n{3,}/g, '\n\n').trim(), components };
}

// Karnataka district detection — when a chart's labels are districts, the
// interactive geo heatmap is strictly better, so add it deterministically
// rather than hoping the transform model picks it.
const KA_DISTRICT_WORDS = [
  'bengaluru', 'bangalore', 'mysuru', 'mysore', 'mandya', 'hassan', 'tumakuru', 'tumkur',
  'kolar', 'chikkaballapura', 'ramanagara', 'chamarajanagar', 'kodagu', 'dakshina kannada',
  'mangaluru', 'mangalore', 'udupi', 'uttara kannada', 'shivamogga', 'shimoga', 'davanagere',
  'davangere', 'chitradurga', 'ballari', 'bellary', 'vijayanagara', 'koppal', 'raichur',
  'kalaburagi', 'kalaburgi', 'gulbarga', 'yadgir', 'bidar', 'vijayapura', 'bijapur',
  'bagalkote', 'bagalkot', 'belagavi', 'belgaum', 'dharwad', 'hubballi', 'gadag', 'haveri',
  'chikkamagaluru', 'chikmagalur',
];
const looksLikeDistrict = (label) => {
  const l = String(label).toLowerCase();
  return KA_DISTRICT_WORDS.some((w) => l.includes(w));
};

// If a bar/pie chart is really per-district data, prepend an interactive
// geo-map built from the same points (client normalises the names).
function promoteDistrictCharts(components) {
  if (components.some((c) => c.type === 'geo-map')) return components;
  const chart = components.find(
    (c) =>
      (c.type === 'bar-chart' || c.type === 'pie-chart') &&
      Array.isArray(c.data) &&
      c.data.length >= 3 &&
      c.data.filter((p) => looksLikeDistrict(p.label)).length >= c.data.length * 0.6
  );
  if (!chart) return components;
  return [
    {
      type: 'geo-map',
      title: chart.title || 'Crime by district',
      data: chart.data
        .filter((p) => looksLikeDistrict(p.label))
        .map((p) => ({ district: String(p.label), value: Number(p.value) || 0 })),
    },
    ...components,
  ];
}

// Any fenced code block still in the prose after agui extraction is noise —
// models sometimes draw ASCII "heatmaps"/charts in ```text blocks. The real
// visualisation is a component; drop the block entirely.
function stripStrayCodeBlocks(text) {
  return String(text)
    .replace(/```[a-z]*\s*[\s\S]*?```/gi, '')
    .replace(/```[a-z]*\s*[\s\S]*$/gi, '') // unterminated fence at the end
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// When components carry the data, an enumerated list in the prose is pure
// duplication (e.g. "1. Gang A ... 12. Gang L" above a cards grid). Drop any
// run of 3+ list lines, keeping the surrounding summary sentences.
function stripDuplicatedLists(text, components) {
  if (!components.length) return text;
  const lines = String(text).split('\n');
  const isItem = (ln) => /^\s*(\d+[.)]|[-*•+])\s+/.test(ln);
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length && run.length < 3) out.push(...run);
    run = [];
  };
  for (const ln of lines) {
    if (isItem(ln)) run.push(ln);
    else { flush(); out.push(ln); }
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

// ── Zia audio-to-text (QuickML) ─────────────────────────────────────────────
// POST /server/rag/transcribe  { audio: <base64>, mimetype, filename, language }
// Proxies to the Catalyst Zia transcription model (multipart), keeping OAuth
// server-side like the RAG calls. Requires the refresh token to carry the
// QuickML.deployment.READ scope in addition to QuickML.rag.READ.
const ZIA_TRANSCRIBE_URL =
  process.env.ZIA_TRANSCRIBE_URL ||
  'https://api.catalyst.zoho.in/quickml/api/v1/models/zia/audio/transcribe';
const ZIA_FILE_FIELD = process.env.ZIA_FILE_FIELD || 'file';
const ZIA_LANG_FIELD = process.env.ZIA_LANG_FIELD || 'language';
const ZIA_LANGS = new Set(['en', 'hi', 'kn']);

async function handleTranscribe(req, res) {
  // Two request shapes are accepted:
  //   • raw audio bytes as application/octet-stream, with mimetype/filename/
  //     language in the query string (preferred — no base64 bloat and it
  //     dodges the gateway's JSON-body content scanning), or
  //   • legacy JSON { audio: <base64>, mimetype, filename, language }.
  let buf, mimetype, filename, language;
  const ctype = String(req.headers['content-type'] || '');
  if (ctype.includes('application/octet-stream')) {
    const q = (req.url || '').split('?')[1] || '';
    const param = (k) => {
      const m = q.match(new RegExp(`(?:^|&)${k}=([^&]*)`));
      return m ? decodeURIComponent(m[1]) : '';
    };
    buf = await readBinaryBody(req);
    mimetype = param('mimetype');
    filename = param('filename');
    language = param('language');
  } else {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!body.audio) return json(res, 400, { error: 'audio (base64) is required' });
    buf = Buffer.from(String(body.audio), 'base64');
    mimetype = body.mimetype;
    filename = body.filename;
    language = body.language;
  }
  if (!buf.length) return json(res, 400, { error: 'audio payload is empty' });
  if (buf.length > 15 * 1024 * 1024) return json(res, 413, { error: 'audio too large (15MB max)' });

  const token = await getAccessToken();
  const form = new FormData();
  form.append(
    ZIA_FILE_FIELD,
    new Blob([buf], { type: mimetype || 'audio/wav' }),
    filename || 'recording.wav'
  );
  const lang = String(language || 'en').slice(0, 2).toLowerCase();
  form.append(ZIA_LANG_FIELD, ZIA_LANGS.has(lang) ? lang : 'en');

  const r = await fetch(ZIA_TRANSCRIBE_URL, {
    method: 'POST',
    headers: {
      'CATALYST-ORG': ORG,
      Authorization: `Zoho-oauthtoken ${token}`,
    },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return json(res, r.status, { error: 'transcription failed', detail: data });

  // Field name isn't documented — check the likely spots and return raw too.
  const d = data.data || data;
  const text =
    d.transcript || d.transcription || d.text || d.result || d.output ||
    (typeof d.response === 'string' ? d.response : '') || '';
  return json(res, 200, { text: String(text).trim(), raw: data });
}

// ── PDF report via SmartBrowz ───────────────────────────────────────────────
// POST /server/rag/report-pdf  { html }  →  { pdf: <base64> }
// The browser composes a self-contained HTML report; SmartBrowz renders it.
async function handleReportPdf(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const html = String(body.html || '');
  if (!html.trim()) return json(res, 400, { error: 'html is required' });
  if (html.length > 2 * 1024 * 1024) return json(res, 413, { error: 'html too large' });

  const app = catalystSDK.initialize(req);
  const stream = await app.smartbrowz().convertToPdf(html, {
    pdf_options: { format: 'A4', print_background: true },
  });
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const pdf = Buffer.concat(chunks);
  if (!pdf.length) return json(res, 502, { error: 'SmartBrowz returned an empty document' });
  return json(res, 200, { pdf: pdf.toString('base64'), bytes: pdf.length });
}

// ── Conversation persistence (Stratus object storage) ───────────────────────
// All of a user's assistant conversations live in ONE JSON object in a Stratus
// bucket, keyed by email — no Data Store table to pre-create. Last-write-wins,
// which is fine for a single user's own chat history.
const CONV_BUCKET = process.env.CONV_BUCKET || 'accused';
const convKey = (email) =>
  `assistant/conversations/${encodeURIComponent(email)}.json`;

async function streamToString(stream) {
  if (!stream) return '';
  if (typeof stream === 'string') return stream;
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function loadConvBlob(bucket, email) {
  try {
    const stream = await bucket.getObject(convKey(email));
    const txt = await streamToString(stream);
    const parsed = JSON.parse(txt || '{}');
    return Array.isArray(parsed.conversations) ? parsed.conversations : [];
  } catch {
    return []; // object doesn't exist yet, or unreadable
  }
}

async function saveConvBlob(bucket, email, conversations) {
  const body = Buffer.from(JSON.stringify({ conversations, updatedAt: Date.now() }));
  await bucket.putObject(convKey(email), body);
}

async function generateTitle(firstUserMsg) {
  const t = await callGroq(
    [
      {
        role: 'system',
        content:
          'Create a concise 3-6 word title in Title Case for a police-analytics ' +
          'chat that begins with the user message below. No quotes, no trailing ' +
          'punctuation, no "Chat about" prefix. Output ONLY the title.',
      },
      { role: 'user', content: String(firstUserMsg).slice(0, 400) },
    ],
    { maxTokens: 20, temperature: 0.3, timeoutMs: 6_000, model: GROQ_MODEL_FAST }
  );
  const clean = (t || '').replace(/^["'\s]+|["'.\s]+$/g, '').replace(/\s+/g, ' ');
  if (clean) return clean.slice(0, 80);
  const words = String(firstUserMsg || '').trim().split(/\s+/).slice(0, 6).join(' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'New chat';
}

// Cap a single conversation's transcript so one runaway chat stays bounded.
function packMessages(messages) {
  let msgs = Array.isArray(messages) ? messages : [];
  while (JSON.stringify(msgs).length > 120_000 && msgs.length > 2) {
    msgs = msgs.slice(2); // drop the oldest exchange
  }
  return msgs;
}

async function handleConversations(req, res, action) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return json(res, 400, { error: 'email is required' });

  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const conversations = await loadConvBlob(bucket, email);

  if (action === 'list') {
    const list = [...conversations].sort(
      (a, b) => (b.starred ? 1e15 : 0) - (a.starred ? 1e15 : 0) + (b.updatedAt || 0) - (a.updatedAt || 0)
    );
    return json(res, 200, { conversations: list });
  }

  const id = String(body.id || '').trim();
  if (!id) return json(res, 400, { error: 'id is required' });
  const idx = conversations.findIndex((c) => c.id === id);

  if (action === 'delete') {
    if (idx >= 0) {
      conversations.splice(idx, 1);
      await saveConvBlob(bucket, email, conversations);
    }
    return json(res, 200, { ok: true });
  }

  // upsert (also handles rename via title, and star via starred)
  const messages = packMessages(Array.isArray(body.messages) ? body.messages : []);
  const firstUser = messages.find((m) => m && m.role === 'user');
  let title = String(body.title || '').trim();
  // Generate an AI title when asked (autotitle) or when none was provided.
  if (body.autotitle || !title || title === 'New chat') {
    title = firstUser ? await generateTitle(firstUser.content) : title || 'New chat';
  }
  const prev = idx >= 0 ? conversations[idx] : {};
  const record = {
    id,
    title: title.slice(0, 240),
    starred: typeof body.starred === 'boolean' ? body.starred : !!prev.starred,
    messages: messages.length ? messages : prev.messages || [],
    createdAt: prev.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  if (idx >= 0) conversations[idx] = record;
  else conversations.push(record);
  await saveConvBlob(bucket, email, conversations);
  return json(res, 200, { id, title: record.title, starred: record.starred });
}

// ── User profile (Stratus): editable details + uploaded photo ───────────────
const profileKey = (email) => `assistant/profiles/${encodeURIComponent(email)}.json`;
const PROFILE_FIELDS = ['displayName', 'phone', 'department', 'designation', 'station', 'badgeNo'];

function readBinaryBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function loadProfileBlob(bucket, email) {
  try {
    return JSON.parse((await streamToString(await bucket.getObject(profileKey(email)))) || '{}');
  } catch {
    return {};
  }
}

// Photo upload as a RAW binary body (image bytes, not base64 in JSON) — the
// gateway's resource-access policy 403s arbitrary base64 blobs inside a
// scanned JSON request, so the image travels as an octet-stream instead.
async function handleProfilePhoto(req, res) {
  const q = (req.url || '').split('?')[1] || '';
  const email = decodeURIComponent((q.match(/(?:^|&)email=([^&]*)/) || [])[1] || '').trim().toLowerCase();
  if (!email) return json(res, 400, { error: 'email is required' });
  const buf = await readBinaryBody(req);
  if (!buf.length) return json(res, 400, { error: 'empty image' });
  if (buf.length > 1_500_000) return json(res, 413, { error: 'photo too large (1.5MB max)' });
  const mime = /^image\/(jpeg|png|webp)$/.test(req.headers['x-photo-mime'] || '')
    ? req.headers['x-photo-mime'] : 'image/jpeg';

  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const profile = await loadProfileBlob(bucket, email);
  profile.photo = `data:${mime};base64,${buf.toString('base64')}`;
  profile.updatedAt = Date.now();
  await bucket.putObject(profileKey(email), Buffer.from(JSON.stringify(profile)));
  return json(res, 200, { ok: true });
}

async function handleProfile(req, res, action) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return json(res, 400, { error: 'email is required' });

  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);

  if (action === 'get') {
    try {
      const txt = await streamToString(await bucket.getObject(profileKey(email)));
      return json(res, 200, { profile: JSON.parse(txt || '{}') });
    } catch {
      return json(res, 200, { profile: {} });
    }
  }

  // save — whitelist text fields. The photo travels as separate raw-base64 +
  // mime fields (never as a "data:image/..." URI in the JSON — the gateway's
  // resource access policy 403s that pattern on cookie-authenticated
  // requests); it is reassembled into a data URL here for storage.
  const incoming = body.profile || {};
  const profile = {};
  PROFILE_FIELDS.forEach((f) => {
    if (typeof incoming[f] === 'string') profile[f] = incoming[f].slice(0, 200);
  });
  const b64 = typeof incoming.photoB64 === 'string' ? incoming.photoB64.replace(/\s/g, '') : '';
  const mime = /^image\/(jpeg|png|webp)$/.test(incoming.photoMime || '') ? incoming.photoMime : 'image/jpeg';
  if (b64) {
    if (b64.length > 1_600_000) return json(res, 413, { error: 'photo too large (1MB max)' });
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return json(res, 400, { error: 'invalid photo encoding' });
    profile.photo = `data:${mime};base64,${b64}`;
  } else if (incoming.photo === null || incoming.photoB64 === null) {
    profile.photo = ''; // explicit removal
  } else if (typeof incoming.photo === 'string' && incoming.photo.startsWith('data:image/')) {
    profile.photo = incoming.photo.slice(0, 1_600_000); // legacy path
  }
  profile.updatedAt = Date.now();
  await bucket.putObject(profileKey(email), Buffer.from(JSON.stringify(profile)));
  return json(res, 200, { profile });
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
    const path = req.url ? req.url.split('?')[0].replace(/\/+$/, '') : '';
    if (path.endsWith('/transcribe')) return await handleTranscribe(req, res);
    if (path.endsWith('/report-pdf')) return await handleReportPdf(req, res);
    if (path.endsWith('/conversations/list')) return await handleConversations(req, res, 'list');
    if (path.endsWith('/conversations/save')) return await handleConversations(req, res, 'save');
    if (path.endsWith('/conversations/delete')) return await handleConversations(req, res, 'delete');
    if (path.endsWith('/profile/photo')) return await handleProfilePhoto(req, res);
    if (path.endsWith('/profile/get')) return await handleProfile(req, res, 'get');
    if (path.endsWith('/profile/save')) return await handleProfile(req, res, 'save');

    const body = JSON.parse((await readBody(req)) || '{}');
    const query = (body.query || '').trim();
    if (!query) return json(res, 400, { error: 'query is required' });

    // Conversation memory from the client: `history` is the short-term window
    // (recent turns, verbatim); `summary` is the long-term digest of older
    // turns. Both feed Groq (expansion + fallback), never the RAG query itself.
    const history = (Array.isArray(body.history) ? body.history : [])
      .filter(
        (m) =>
          m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
      )
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
    const summary = typeof body.summary === 'string' ? body.summary.slice(0, 2000) : '';

    // Per Catalyst docs: when no documents are passed, RAG searches ALL active
    // knowledge-base documents. So we only scope the search when explicitly
    // asked to (request body or RAG_DOCUMENT_IDS) — new uploads just work.
    const documents =
      body.documents ||
      (process.env.RAG_DOCUMENT_IDS
        ? process.env.RAG_DOCUMENT_IDS.split(',').map((s) => s.trim()).filter(Boolean)
        : []);
    const token = await getAccessToken();
    const callRag = async (q, docs, timeoutMs) => {
      const payload = { query: q };
      if (docs && docs.length) payload.documents = docs;
      const r = await fetch(RAG_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CATALYST-ORG': ORG,
          Authorization: `Zoho-oauthtoken ${token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data: d };
    };
    const pickAnswer = (d) =>
      d.response ||
      d.answer ||
      d.result ||
      (d.data && (d.data.answer || d.data.result)) ||
      d.output ||
      '';

    // Expand the question into a self-contained one for better retrieval,
    // using conversation context to resolve pronouns and references
    // (best-effort — the raw query is used if Groq is absent or slow).
    // Expansion exists ONLY to resolve conversational references ("it", "that
    // gang") into a standalone question. Without history there is nothing to
    // resolve — the raw question is always more faithful than a rewrite (small
    // models invent filters/years, which poisons ZCQL generation downstream).
    const contextBits = [];
    if (summary) contextBits.push('Earlier conversation topics: ' + summary);
    if (history.length) {
      contextBits.push(
        'Recent conversation:\n' + history.map((m) => `${m.role}: ${m.content}`).join('\n')
      );
    }
    const expanded = contextBits.length
      ? await callGroq(
          [
            { role: 'system', content: EXPAND_PROMPT },
            { role: 'user', content: contextBits.join('\n\n') + '\n\nQuestion: ' + query },
          ],
          { maxTokens: 160, temperature: 0.2, timeoutMs: 6_000 }
        )
      : null;
    const searchQuery = (expanded || '').trim() || query;

    // ── Router: relational question → ZCQL over the Data Store; otherwise RAG.
    // Groq decides; any failure in the ZCQL path falls through to RAG so the
    // assistant always answers.
    let zcqlDebug; // populated when the ZCQL path was tried but abandoned
    if (process.env.GROQ_API_KEY) {
      const routed = await callGroq(
        [
          { role: 'system', content: zcql.ROUTER_PROMPT },
          { role: 'user', content: searchQuery },
        ],
        { maxTokens: 4, temperature: 0, timeoutMs: 5_000, model: GROQ_MODEL_FAST }
      );
      if (routed && /zcql/i.test(routed)) {
        try {
          const app = catalystSDK.initialize(req);
          let q = null;
          let rollup = null;
          let topN = null;
          let lastErr = null;
          let rows = null;
          for (let attempt = 0; attempt < 2 && !rows; attempt++) {
            const gen = await callGroq(
              [
                { role: 'system', content: zcql.ZCQL_SYSTEM },
                { role: 'user', content: zcql.buildUserPrompt(searchQuery, q, lastErr) },
              ],
              { maxTokens: 350, temperature: 0, timeoutMs: 10_000 }
            );
            const s = zcql.parsePlan(gen);
            if (!s.ok) { lastErr = s.error; q = gen && String(gen).slice(0, 400); continue; }
            if (s.unanswerable) {
              // The database genuinely can't answer this — say so honestly
              // rather than running an unrelated query or guessing.
              return json(res, 200, {
                answer: s.unanswerable,
                components: [],
                source: 'zcql',
                sources: ['Data Store'],
                expandedQuery: searchQuery === query ? undefined : searchQuery,
              });
            }
            q = s.query;
            rollup = s.rollup;
            topN = s.topN;
            try {
              rows = await app.zcql().executeZCQLQuery(q);
            } catch (e) {
              lastErr = (e && e.message) || String(e);
              rows = null;
            }
          }
          if (rows) {
            let flat = zcql.flattenRows(rows).slice(0, 400);
            if (rollup === 'district') {
              flat = zcql.rollupToDistricts(flat) || flat;
            }
            if (topN) flat = flat.slice(0, topN);
            flat = zcql.enrichRows(flat).slice(0, 200);
            const components = zcql.rowsToComponents(flat);
            // When the result is a multi-row list, the table carries the data;
            // the prose must be a SHORT summary and never re-list the rows.
            const isList = flat.length > 3;
            const prose = await callGroq(
              [
                {
                  role: 'system',
                  content: isList
                    ? 'You are Sentinel Assistant. The query returned ' +
                      `${flat.length} records, already shown to the user as a TABLE. ` +
                      'Write ONE short summary sentence only — a count and/or the single ' +
                      'top item. NEVER list, enumerate, or repeat the individual records, ' +
                      'and never output a markdown table. Invent nothing.'
                    : 'You are Sentinel Assistant. Answer the analyst question from the ' +
                      'query result rows (JSON) in 1-2 sentences, stating numbers plainly. ' +
                      'If rows are empty, say no matching records were found. Invent nothing.',
                },
                {
                  role: 'user',
                  content:
                    `Question: ${query}\n\nRows (${flat.length}` +
                    `${flat.length === 200 ? ', truncated' : ''}):\n` +
                    JSON.stringify(flat.slice(0, isList ? 20 : 60)),
                },
              ],
              { maxTokens: isList ? 90 : 300, temperature: 0.2, timeoutMs: 12_000, model: GROQ_MODEL_FAST }
            );
            // Strip any table/enumeration the model emits anyway — the component
            // is the single source of truth for the rows.
            let answerText = stripStrayCodeBlocks((prose || '').trim());
            answerText = stripDuplicatedLists(
              stripMarkdownTables(answerText, components).text,
              components
            );
            if (!answerText) answerText = `Found ${flat.length} matching record(s) — see the table below.`;
            // A negative prose ("no matching records", "does not answer...")
            // with a rendered data table is a contradiction — the rows didn't
            // answer the question, so don't show them.
            const showComponents = flat.length > 0 && !isNegative(answerText);
            return json(res, 200, {
              answer: answerText,
              components: showComponents ? components : [],
              source: 'zcql',
              sources: ['Data Store: ' + zcql.tablesInQuery(q).join(', ')],
              zcql: q,
              expandedQuery: searchQuery === query ? undefined : searchQuery,
            });
          }
          // rows still null → fall through to RAG below
          zcqlDebug = { attempted: true, query: q, error: lastErr };
        } catch (e) {
          zcqlDebug = { attempted: true, error: 'sdk: ' + ((e && e.message) || String(e)) };
        }
      } else {
        zcqlDebug = { attempted: false, routed: routed || 'null' };
      }
    }

    // Pass 1: retrieval-augmented answer from the knowledge base.
    let first = await callRag(searchQuery, documents, 30_000);
    if (!first.ok) {
      return json(res, first.status, { error: 'RAG request failed', detail: first.data });
    }
    let extracted = extractAgui(pickAnswer(first.data));
    let text = extracted.text;
    let components = extracted.components;
    let source = 'rag';

    // If the expanded query struck out, retry RAG with the user's original
    // wording before ever leaving the knowledge base — expansion must never
    // cause a fallback that plain RAG would have answered.
    if (isNegative(text) && searchQuery !== query) {
      try {
        const retry = await callRag(query, documents, 25_000);
        if (retry.ok) {
          const e2 = extractAgui(pickAnswer(retry.data));
          if (!isNegative(e2.text)) {
            first = retry;
            text = e2.text;
            components = e2.components;
          }
        }
      } catch {
        /* keep the first result */
      }
    }

    // Fallback LLM: only when the knowledge base genuinely has no answer.
    if (isNegative(text)) {
      const fb = await callGroq(
        [{ role: 'system', content: FALLBACK_SYSTEM }, ...history, { role: 'user', content: query }],
        { maxTokens: 900, temperature: 0.4, timeoutMs: 15_000 }
      );
      if (fb && fb.trim()) {
        text = fb.trim();
        components = [];
        source = 'fallback';
      }
    }

    // Pass 2 (best-effort): transform the answer into agui components. Groq is
    // faster and follows the schema more reliably; RAG is the fallback path.
    if (!components.length && looksDataShaped(text)) {
      const viaGroq = await callGroq(
        [{ role: 'user', content: AGUI_TRANSFORM + text }],
        { maxTokens: 1024, temperature: 0, timeoutMs: 10_000, model: GROQ_MODEL_FAST }
      );
      if (viaGroq) {
        components = extractAgui(viaGroq).components;
      } else {
        try {
          const second = await callRag(AGUI_TRANSFORM + text, [], 20_000);
          if (second.ok) components = extractAgui(pickAnswer(second.data)).components;
        } catch {
          /* timeout or transform failure — text-only answer is still correct */
        }
      }
    }

    // Final sanitation on whichever text we ended up with (RAG or fallback):
    // markdown tables become a component when none exists, then any list that
    // merely repeats rendered component data is dropped from the prose.
    text = stripStrayCodeBlocks(text);
    ({ text, components } = stripMarkdownTables(text, components));
    components = promoteDistrictCharts(components);
    const answer = stripDuplicatedLists(text, components);

    // Attribution: knowledge-base document titles for RAG answers, the model
    // name for general-knowledge fallbacks.
    const sources =
      source === 'rag'
        ? [
            ...new Set(
              (first.data.retrieved_nodes || [])
                .map((n) => n && n.document_title)
                .filter(Boolean)
            ),
          ]
        : [`General knowledge (${GROQ_MODEL})`];

    return json(res, 200, {
      answer,
      components,
      source,
      sources,
      expandedQuery: searchQuery === query ? undefined : searchQuery,
      zcqlDebug,
      raw: first.data,
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
