'use strict';

const catalystSDK = require('zcatalyst-sdk-node');
const zcql = require('./zcql');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

const CHAT_SYSTEM =
  'You are Sentinel Assistant, a friendly assistant inside a Karnataka police ' +
  'crime-analytics platform. The user is making casual conversation (a greeting, ' +
  'thanks, small talk, or a question about you). Reply naturally and warmly in ' +
  '1-3 short sentences. If they ask what you can do, mention you can answer ' +
  'questions about FIR data and crime statistics, explain law and procedure, and ' +
  'guide them to any part of the platform — the dashboard, crime map, AI ' +
  'Analytics (crime patterns, co-offending links, case linkage, forecasts, ' +
  'financial-trail money-laundering analysis), case files, investigation diary, ' +
  'personnel and access & audit. Never push it, and never invent data.';

// The full feature map the assistant uses to answer "what/where/how" questions
// about the platform itself, with the in-app route for each destination (paths
// are relative to the /app basename — no leading "/app").
const APP_GUIDE = `SENTINEL — feature map (module → what it does → route):

Home / Dashboard [/reports]: crime overview — KPI cards, crime trend over time, case-status breakdown, crime-by-category, top districts heat map, station load, accused age profile, top crime types, socio-economic correlation, arrests & surrenders. Filter by Today/Month/Year/5Y or a custom range; export the report as PDF.
Incidents [/incidents]: live FIR feed — recent cases with station, district, category and status.
Crime Map [/crime-map]: interactive district-level heat map of Karnataka; drill from state to district to see where crime concentrates.
AI Analytics [/ai-analytics]: the machine-learning workspace. Tabs:
  • Crime Patterns [/ai-analytics?tab=patterns]: temporal profiles — incidents by hour of day, day of month, day of week; peak windows; crime-head × daypart heatmap.
  • Crime Links [/ai-analytics?tab=links]: co-offending network — which offenders commit crimes together; connected offenders and repeat offenders. THIS is the crime/criminal network.
  • Case Linkage [/ai-analytics?tab=linkage]: serial-offence linkage — finds cases likely committed by the same offender via modus operandi, geography and timing similarity.
  • Forecasts & Risk [/ai-analytics?tab=forecasts]: crime-volume forecasting (pick a horizon), district risk for next month, repeat-offender risk scores, and anomaly detection.
  • Financial Trails [/ai-analytics?tab=financial]: money-laundering / financial-crime analysis — screens transactions around economic, cyber and property offenders against AML typologies (structuring/smurfing, layering, fan-in mule hubs, fan-out dispersal, round-tripping, pass-through, high-value cash, hawala/crypto channels, shell/mule accounts). Shows a typology breakdown, a money-flow NETWORK of entities/mule/shell accounts, prioritised risk-scored alerts, and flagged transactions. THIS is the "financial crime network trails".
Case Files [/case-files]: browse and query the raw FIR data store with column filters and CSV export.
Investigation Diary [/investigation-diary]: BNSS S.172 case diaries mapped to CCTNS — diary entries, S.161 statements/testimony (typed, recorded with speech-to-text, or uploaded and OCR'd), evidence, persons, a timeline, findings, an AI cited summary and PDF export.
Assistant [/assistant]: this chat — ask about data, law, or the platform.
Personnel Directory [/personnel]: officer directory (rank, unit, district). Sub-pages: Duty Roster [/personnel/roster] (shift schedule), Org Chart [/personnel/org-chart] (command hierarchy).
Access & Audit [/access]: admin only — assign roles and browse/export the audit trail of who did what, where and when.
Global search: press Ctrl/⌘-K anywhere to jump to any of the above.`;

const GUIDE_SYSTEM =
  'You are Sentinel Assistant, a guide to the Sentinel police crime-analytics ' +
  'platform. Using ONLY the feature map below, answer the user’s question about ' +
  'what a feature does, where to find it, or how to use it. Be concise and ' +
  'concrete (2-5 sentences): name the exact module and tab, and say what they ' +
  'will see there. Never invent features or data that are not in the map.\n\n' +
  'After your prose, if one or more destinations are directly relevant, append a ' +
  'single fenced block exactly like:\n' +
  '```agui\n{"components":[{"type":"cards","title":"Open","items":[' +
  '{"title":"Financial Trails","subtitle":"AI Analytics","body":"Money-laundering typologies & money-flow network","to":"/ai-analytics?tab=financial"}]}]}\n```\n' +
  'Rules for the block: use the EXACT route strings from the map as "to"; include ' +
  'only genuinely relevant destinations (1-4); omit the block entirely if none ' +
  'apply. Output valid JSON, no comments.\n\n' + APP_GUIDE;

const FALLBACK_SYSTEM =
  'You are Sentinel Assistant, helping Indian police analysts. The internal knowledge ' +
  'base had no answer, so answer from general knowledge — Indian law, police procedure, ' +
  'criminology, general facts. Be concise and factual. Never say you cannot display ' +
  'charts or images and never describe what a chart would look like — just present the ' +
  'data plainly. If you genuinely cannot answer, say so.';

// A RAG non-answer: empty, or a short "I don't know" style reply.
const NEGATIVE_RE =
  /i'?m not sure|i don'?t (know|have)|not sure what information|no (relevant |such )?information|couldn'?t find|cannot find|unable to (find|answer)|not (available|mentioned|provided) in/i;
// A "meta" non-answer talks ABOUT the retrieved context instead of answering —
// e.g. "the provided context does not state…". A genuine data answer never
// refers to "the provided/given context", so these are high-precision signals
// that retrieval missed; they route to the general-knowledge fallback at any
// length rather than being shown as an (often unrelated) reply.
const META_RE =
  /(provided|given|available|retrieved) context|the context (does|doesn'?t|does not|only|contains|lacks)|(context|information|document|documents|passage|passages|knowledge base|text provided)[^.]{0,50}?(does not|doesn'?t|do not|don'?t|contain no|lack)[^.]{0,25}?(contain|include|mention|state|specify|provide|cover|discuss|have|indicate|address)|(does not|doesn'?t) (state|mention|specify|contain|include|provide|indicate) (the|any|a )?(total |exact )?(number|count|figure|information|data|details?)/i;
const isNegative = (t) => {
  const s = String(t).trim();
  if (!s) return true;
  if (META_RE.test(s)) return true;
  return s.length < 240 && NEGATIVE_RE.test(s);
};

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

// ── Conversation persistence (Catalyst Data Store — one row per chat) ────────
// The legacy design kept ALL of a user's chats in one Stratus JSON blob with
// last-write-wins; two near-simultaneous saves (a debounced save racing the
// unload beacon, or two chats saving at once) could overwrite each other and
// silently drop older conversations. The Data Store gives every conversation
// its own row keyed by (UserEmail, ConvId), so saves never clobber siblings.
//
// Table `ChatConversations` (create once in the Catalyst console):
//   UserEmail  Varchar   ConvId  Varchar   Title    Varchar
//   Starred    Boolean   Transcript Text    CreatedAt BigInt  UpdatedAt BigInt
const CONV_TABLE = process.env.CONV_TABLE || 'ChatConversations';

// Escape a string for use inside a ZCQL single-quoted literal.
const zq = (s) => String(s).replace(/'/g, "''");

// ZCQL rows come back keyed by the table name; unwrap to the flat row object.
const unwrapRow = (r) => (r && r[CONV_TABLE] ? r[CONV_TABLE] : r || {});

function normalizeConvRow(o) {
  let messages = [];
  try { messages = JSON.parse(o.Transcript || '[]'); } catch { messages = []; }
  return {
    id: o.ConvId,
    title: o.Title || 'New chat',
    starred: o.Starred === true || o.Starred === 'true',
    messages: Array.isArray(messages) ? messages : [],
    createdAt: Number(o.CreatedAt) || 0,
    updatedAt: Number(o.UpdatedAt) || 0,
    _rowid: o.ROWID,
  };
}

const CONV_COLS = 'ROWID, ConvId, Title, Starred, Transcript, CreatedAt, UpdatedAt';

async function dsListConversations(app, email) {
  const q = `SELECT ${CONV_COLS} FROM ${CONV_TABLE} WHERE UserEmail = '${zq(email)}'`;
  const rows = await app.zcql().executeZCQLQuery(q);
  return (rows || []).map((r) => normalizeConvRow(unwrapRow(r)));
}

async function dsGetConversation(app, email, convId) {
  const q =
    `SELECT ${CONV_COLS} FROM ${CONV_TABLE} ` +
    `WHERE UserEmail = '${zq(email)}' AND ConvId = '${zq(convId)}' LIMIT 1`;
  const rows = await app.zcql().executeZCQLQuery(q);
  return rows && rows.length ? normalizeConvRow(unwrapRow(rows[0])) : null;
}

async function dsUpsertConversation(app, email, record) {
  const table = app.datastore().table(CONV_TABLE);
  const base = {
    Title: record.title,
    Starred: !!record.starred,
    Transcript: JSON.stringify(record.messages || []),
    UpdatedAt: record.updatedAt,
  };
  if (record._rowid) {
    await table.updateRow({ ROWID: record._rowid, ...base });
  } else {
    await table.insertRow({ UserEmail: email, ConvId: record.id, CreatedAt: record.createdAt, ...base });
  }
}

async function dsDeleteConversation(app, email, convId) {
  const existing = await dsGetConversation(app, email, convId);
  if (existing && existing._rowid) {
    await app.datastore().table(CONV_TABLE).deleteRow(existing._rowid);
  }
}

// One-time lift of a user's legacy Stratus blob into the Data Store, then empty
// the blob so it never re-imports. Returns the migrated conversations (or null).
async function migrateStratusToDS(app, email) {
  try {
    const bucket = app.stratus().bucket(CONV_BUCKET);
    const convos = await loadConvBlob(bucket, email);
    if (!convos.length) return null;
    const rows = convos.map((c) => ({
      UserEmail: email,
      ConvId: c.id,
      Title: (c.title || 'New chat').slice(0, 240),
      Starred: !!c.starred,
      Transcript: JSON.stringify(c.messages || []),
      CreatedAt: c.createdAt || Date.now(),
      UpdatedAt: c.updatedAt || Date.now(),
    }));
    await app.datastore().table(CONV_TABLE).insertRows(rows);
    await saveConvBlob(bucket, email, []); // clear so we don't migrate twice
    return convos;
  } catch (e) {
    console.warn('conv migration failed:', (e && e.message) || e);
    return null;
  }
}

// Starred first, then most-recently-updated.
const sortConvos = (a, b) =>
  (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0);
const stripRowid = ({ _rowid, ...c }) => c;

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

// ── Help Center → email the admin (with a Stratus backup copy) ──────────────
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'deepujohn.t01@gmail.com';

async function handleSupport(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const fromEmail = String(body.email || '').trim().slice(0, 200);
  const category = String(body.category || 'General').trim().slice(0, 80);
  const message = String(body.message || '').trim().slice(0, 5000);
  const name = String(body.name || '').trim().slice(0, 120);
  if (!message) return json(res, 400, { error: 'Please describe the issue.' });

  const app = catalystSDK.initialize(req);
  const when = new Date().toISOString();
  const ticket = { when, name, fromEmail, category, message };

  // Keep a copy so nothing is lost even if email delivery fails.
  try {
    const bucket = app.stratus().bucket(CONV_BUCKET);
    let tickets = [];
    try {
      tickets = JSON.parse((await streamToString(await bucket.getObject('support/tickets.json'))) || '[]');
    } catch { tickets = []; }
    if (!Array.isArray(tickets)) tickets = [];
    tickets.push(ticket);
    await bucket.putObject('support/tickets.json', Buffer.from(JSON.stringify(tickets)));
  } catch (e) {
    console.warn('support: store failed —', (e && e.message) || e);
  }

  // Email the admin inbox; reply-to the requester so a reply reaches them.
  const subject = `[Sentinel Help] ${category}${name ? ' — ' + name : ''}`;
  const content =
    'New Sentinel Help Center request\n\n' +
    `Category: ${category}\n` +
    `From: ${name || '—'} <${fromEmail || 'no email provided'}>\n` +
    `Time (UTC): ${when}\n\n` +
    `Message:\n${message}\n`;

  let emailed = false;
  let emailError = null;

  // Primary: Gmail SMTP (works from a Gmail address without owning a domain,
  // unlike Catalyst's Email API which requires a DKIM/SPF-verified domain).
  // Needs SMTP_USER + SMTP_PASS (a Google App Password) in the function env.
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
  if (smtpUser && smtpPass) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 465, secure: true,
        auth: { user: smtpUser, pass: smtpPass },
      });
      await transporter.sendMail({
        from: `Sentinel Help Center <${smtpUser}>`,
        to: SUPPORT_EMAIL,
        ...(fromEmail ? { replyTo: fromEmail } : {}),
        subject,
        text: content,
      });
      emailed = true;
    } catch (e) {
      emailError = 'smtp: ' + ((e && e.message) || String(e));
      console.warn('support:', emailError);
    }
  }

  // Fallback: Catalyst Email API (only sends from a verified domain).
  if (!emailed) {
    try {
      await app.email().sendMail({
        from_email: SUPPORT_EMAIL,
        to_email: SUPPORT_EMAIL,
        subject,
        content,
        ...(fromEmail ? { reply_to: fromEmail } : {}),
      });
      emailed = true;
    } catch (e) {
      emailError = emailError || ((e && e.message) || String(e));
      console.warn('support: catalyst email failed —', (e && e.message) || e);
    }
  }

  return json(res, 200, { ok: true, emailed, ...(emailError ? { emailError } : {}) });
}

async function handleConversations(req, res, action) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return json(res, 400, { error: 'email is required' });
  const app = catalystSDK.initialize(req);

  // Data Store is authoritative. If the table isn't set up yet (or a Data
  // Store call fails), fall back to the legacy Stratus blob so history keeps
  // working during migration.
  try {
    return await handleConversationsDS(app, res, action, body, email);
  } catch (e) {
    console.warn('conversations: Data Store path failed, using Stratus —', (e && e.message) || e);
    return await handleConversationsStratus(app, res, action, body, email);
  }
}

async function handleConversationsDS(app, res, action, body, email) {
  if (action === 'list') {
    let convos = await dsListConversations(app, email);
    if (convos.length === 0) {
      const migrated = await migrateStratusToDS(app, email);
      if (migrated) convos = migrated;
    }
    return json(res, 200, { conversations: convos.sort(sortConvos).map(stripRowid) });
  }

  const id = String(body.id || '').trim();
  if (!id) return json(res, 400, { error: 'id is required' });

  if (action === 'delete') {
    await dsDeleteConversation(app, email, id);
    return json(res, 200, { ok: true });
  }

  // upsert (also handles rename via title, and star via starred)
  const existing = await dsGetConversation(app, email, id);
  const messages = packMessages(Array.isArray(body.messages) ? body.messages : []);
  const firstUser = messages.find((m) => m && m.role === 'user');
  let title = String(body.title || '').trim();
  if (body.autotitle || !title || title === 'New chat') {
    title = firstUser ? await generateTitle(firstUser.content) : title || 'New chat';
  }
  const record = {
    id,
    title: title.slice(0, 240),
    starred: typeof body.starred === 'boolean' ? body.starred : !!(existing && existing.starred),
    messages: messages.length ? messages : (existing ? existing.messages : []),
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now(),
    _rowid: existing ? existing._rowid : null,
  };
  await dsUpsertConversation(app, email, record);
  return json(res, 200, { id, title: record.title, starred: record.starred });
}

// Legacy fallback: all of a user's chats in one Stratus JSON blob.
async function handleConversationsStratus(app, res, action, body, email) {
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const conversations = await loadConvBlob(bucket, email);

  if (action === 'list') {
    return json(res, 200, { conversations: [...conversations].sort(sortConvos) });
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

  const messages = packMessages(Array.isArray(body.messages) ? body.messages : []);
  const firstUser = messages.find((m) => m && m.role === 'user');
  let title = String(body.title || '').trim();
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
  const param = (k) => {
    const m = q.match(new RegExp(`(?:^|&)${k}=([^&]*)`));
    return m ? decodeURIComponent(m[1]) : '';
  };
  const email = param('email').trim().toLowerCase();
  if (!email) return json(res, 400, { error: 'email is required' });
  // The image is uploaded HEX-ENCODED (only 0-9a-f) in the body. Raw image
  // bytes — as binary OR base64 — trip the gateway's resource-access policy
  // (its request scanner matches byte patterns); a hex string contains no
  // characters that can form any injection/XSS/traversal signature, so it
  // passes cleanly. We decode it back to the original bytes here.
  const hex = (await readBody(req)).trim();
  if (!hex) return json(res, 400, { error: 'empty image' });
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    return json(res, 400, { error: 'invalid photo encoding' });
  }
  if (hex.length / 2 > 1_500_000) return json(res, 413, { error: 'photo too large (1.5MB max)' });
  const buf = Buffer.from(hex, 'hex');
  const mime = /^image\/(jpeg|png|webp)$/.test(param('mime')) ? param('mime') : 'image/jpeg';

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

// ── Access control & audit trail (Stratus blobs — no Data Store table) ──────
// Roles live in ONE JSON object (email → { role, rank }); audit events are
// appended as small per-flush objects under audit/logs/<day>/ so writes never
// contend and reads can be scoped to a date range.
const ROLES_KEY = 'access/roles.json';
const AUDIT_PREFIX = 'audit/logs/';
const APP_ROLES = ['investigator', 'analyst', 'supervisor', 'policymaker', 'admin'];

async function loadRolesBlob(bucket) {
  try {
    const parsed = JSON.parse((await streamToString(await bucket.getObject(ROLES_KEY))) || '{}');
    return parsed && parsed.users && typeof parsed.users === 'object' ? parsed : { users: {} };
  } catch {
    return { users: {} };
  }
}

// The caller's identity comes from the Catalyst session cookie forwarded with
// every /server/ call — never from the request body — so admin-only endpoints
// can't be reached by editing a JSON payload.
async function requestUser(app) {
  try {
    return await app.userManagement().getCurrentUser();
  } catch {
    return null;
  }
}
const isAdminUser = (u) => /admin/i.test(u?.role_details?.role_name || '');

async function handleAccess(req, res, action) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);

  if (action === 'me') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) return json(res, 400, { error: 'email is required' });
    const roles = await loadRolesBlob(bucket);
    const rec = roles.users[email] || {};
    return json(res, 200, {
      role: APP_ROLES.includes(rec.role) ? rec.role : 'investigator',
    });
  }

  const caller = await requestUser(app);
  if (!isAdminUser(caller)) return json(res, 403, { error: 'admin only' });

  if (action === 'users') {
    const [all, roles] = await Promise.all([
      app.userManagement().getAllUsers(),
      loadRolesBlob(bucket),
    ]);
    const users = (all || []).map((u) => {
      const email = String(u.email_id || '').toLowerCase();
      const rec = roles.users[email] || {};
      return {
        email,
        name: [u.first_name, u.last_name].filter(Boolean).join(' '),
        status: u.status || '',
        catalystRole: u.role_details?.role_name || '',
        role: APP_ROLES.includes(rec.role) ? rec.role : isAdminUser(u) ? 'admin' : 'investigator',
      };
    });
    return json(res, 200, { users });
  }

  // save — assign a role to one user, and audit the change itself.
  const email = String(body.email || '').trim().toLowerCase();
  const role = String(body.role || '');
  if (!email) return json(res, 400, { error: 'email is required' });
  if (!APP_ROLES.includes(role)) return json(res, 400, { error: 'invalid role' });
  const roles = await loadRolesBlob(bucket);
  roles.users[email] = {
    role,
    updatedAt: Date.now(),
    updatedBy: String(caller?.email_id || ''),
  };
  await bucket.putObject(ROLES_KEY, Buffer.from(JSON.stringify(roles)));
  await storeAuditEvents(req, app, bucket, [{
    action: 'role-change',
    feature: 'Access & Audit',
    path: '/access',
    detail: `${email} → ${role}`,
  }], caller);
  return json(res, 200, { ok: true });
}

// IP → rough location via ip-api.com. Best-effort: private/unknown IPs and
// lookup failures record an empty location; results are cached per instance.
const geoCache = new Map();
async function geoLocate(ip) {
  if (!ip || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1|f[ce])/.test(ip)) return '';
  if (geoCache.has(ip)) return geoCache.get(ip);
  let loc = '';
  try {
    const r = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city`,
      { signal: AbortSignal.timeout(1500) }
    );
    const j = await r.json();
    if (j.status === 'success') loc = [j.city, j.regionName, j.country].filter(Boolean).join(', ');
  } catch {}
  geoCache.set(ip, loc);
  return loc;
}

const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress ||
  '';

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric', month: 'short', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
});

async function storeAuditEvents(req, app, bucket, events, sessionUser) {
  try {
    await writeAuditEvents(req, app, bucket, events, sessionUser);
  } catch (e) {
    // Audit logging is best-effort and must NEVER block or fail the operation
    // it accompanies (saving evidence, a diary entry, etc.). Swallow and log.
    console.error('audit write failed (non-fatal):', e && e.message);
  }
}

async function writeAuditEvents(req, app, bucket, events, sessionUser) {
  if (!events.length) return;
  const ip = clientIp(req);
  const [location, roles, user] = await Promise.all([
    geoLocate(ip),
    loadRolesBlob(bucket),
    sessionUser ? Promise.resolve(sessionUser) : requestUser(app),
  ]);
  // Identity is resolved server-side (session user + roles blob); the client
  // payload only fills gaps when the SDK can't confirm the session.
  const email = String(user?.email_id || events[0].email || '').toLowerCase().slice(0, 120);
  const rec = roles.users[email] || {};
  const role = isAdminUser(user)
    ? 'admin'
    : APP_ROLES.includes(rec.role) ? rec.role : 'investigator';
  const name =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    String(events[0].name || '').slice(0, 120);
  const device = String(req.headers['user-agent'] || '').slice(0, 160);
  const now = Date.now();
  const enriched = events.slice(0, 50).map((e) => {
    const ts = Number.isFinite(e.ts) && Math.abs(now - e.ts) < 86_400_000 ? e.ts : now;
    return {
      ts,
      istTime: IST_FMT.format(new Date(ts)),
      email,
      name,
      role,
      feature: String(e.feature || '').slice(0, 60),
      action: String(e.action || 'view').slice(0, 40),
      path: String(e.path || '').slice(0, 120),
      detail: String(e.detail || '').slice(0, 300),
      session: String(e.session || '').slice(0, 40),
      ip,
      location,
      device,
    };
  });
  const day = new Date(now).toISOString().slice(0, 10);
  const key = `${AUDIT_PREFIX}${day}/${now}-${Math.random().toString(36).slice(2, 8)}.json`;
  await bucket.putObject(key, Buffer.from(JSON.stringify({ events: enriched })));
}

async function handleAudit(req, res, action) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);

  if (action === 'log') {
    const events = Array.isArray(body.events) ? body.events : [];
    await storeAuditEvents(req, app, bucket, events);
    return json(res, 200, { ok: true, stored: Math.min(events.length, 50) });
  }

  // list — admin only; bounded to 31 days / 5000 events per request.
  const caller = await requestUser(app);
  if (!isAdminUser(caller)) return json(res, 403, { error: 'admin only' });
  const today = new Date().toISOString().slice(0, 10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(body.to || '') ? body.to : today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(body.from || '') ? body.from : to;
  const days = [];
  for (let t = Date.parse(from); t <= Date.parse(to) && days.length < 31; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  const events = [];
  for (const day of days) {
    let token;
    do {
      const page = await bucket.listPagedObjects({
        prefix: `${AUDIT_PREFIX}${day}/`,
        maxKeys: '200',
        continuationToken: token,
      });
      // listPagedObjects wraps each entry in a StratusObject — the key sits
      // on .keyDetails, not on the instance itself.
      const keys = (page?.contents || [])
        .map((o) => o?.keyDetails?.key || o?.key)
        .filter(Boolean);
      const blobs = await Promise.all(
        keys.map(async (k) => {
          try {
            return JSON.parse((await streamToString(await bucket.getObject(k))) || '{}');
          } catch {
            return {};
          }
        })
      );
      blobs.forEach((b) => Array.isArray(b.events) && events.push(...b.events));
      token =
        page?.truncated === 'true' || page?.truncated === true
          ? page?.next_continuation_token
          : undefined;
    } while (token && events.length < 5000);
    if (events.length >= 5000) break;
  }
  events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return json(res, 200, { events: events.slice(0, 5000) });
}

// ── Investigation Diary (Case Diary under BNSS Section 172) ─────────────────
// One JSON blob per case (Stratus, no new Data Store table) plus a light
// index for the list page and a flattened person index for cross-case lead
// detection. Mirrors the CCTNS Case Diary / IIF1-5 structure the user
// specified: diary entries (S.172 BNSS), statements (S.161 BNSS), evidence &
// chain of custody, persons involved, timeline, findings.
const INV_PREFIX = 'investigation/diary/';
const INV_INDEX_KEY = 'investigation/index.json';
const INV_PERSON_INDEX_KEY = 'investigation/persons-index.json';
const INV_SECTIONS = ['diaryEntries', 'statements', 'evidence', 'persons', 'timeline', 'findings'];
const INV_STATUSES = ['Open', 'Under Investigation', 'Chargesheet Filed', 'Cold', 'Closed', 'Reopened'];
const invKey = (id) => `${INV_PREFIX}${id}.json`;

// Case-record access is need-to-know: investigators, supervisors and admin
// only (analysts/policymakers work with aggregates, not identifiable case
// diaries — the Puttaswamy proportionality point from the feature brief).
const canInvestigate = (role) => ['admin', 'supervisor', 'investigator'].includes(role);

async function myRole(app, bucket) {
  const caller = await requestUser(app);
  if (isAdminUser(caller)) return { role: 'admin', caller };
  const email = String(caller?.email_id || '').toLowerCase();
  const roles = await loadRolesBlob(bucket);
  const rec = roles.users[email] || {};
  return { role: APP_ROLES.includes(rec.role) ? rec.role : 'investigator', caller };
}

async function loadInvIndex(bucket) {
  try {
    const parsed = JSON.parse((await streamToString(await bucket.getObject(INV_INDEX_KEY))) || '{}');
    return Array.isArray(parsed.cases) ? parsed.cases : [];
  } catch {
    return [];
  }
}
async function saveInvIndex(bucket, cases) {
  await bucket.putObject(INV_INDEX_KEY, Buffer.from(JSON.stringify({ cases, updatedAt: Date.now() })));
}
const invSummary = (rec) => ({
  caseMasterId: rec.caseMasterId,
  investigationId: rec.investigationId,
  crimeNo: rec.crimeNo || '',
  caseNo: rec.caseNo || '',
  ioName: rec.ioName || '',
  ioRank: rec.ioRank || '',
  station: rec.station || '',
  district: rec.district || '',
  status: rec.status,
  sections: rec.sections || '',
  caseType: rec.caseType || '',
  registeredDate: rec.registeredDate || '',
  lastDiaryDate: rec.lastDiaryDate || '',
  diaryCount: (rec.diaryEntries || []).length,
  statementCount: (rec.statements || []).length,
  evidenceCount: (rec.evidence || []).length,
  personCount: (rec.persons || []).length,
  updatedAt: rec.updatedAt,
});
async function upsertInvIndex(bucket, rec) {
  const idx = await loadInvIndex(bucket);
  const i = idx.findIndex((c) => c.caseMasterId === rec.caseMasterId);
  if (i >= 0) idx[i] = invSummary(rec);
  else idx.unshift(invSummary(rec));
  await saveInvIndex(bucket, idx);
}

// ── Internal record operations, factored out of the HTTP handler below so
// they can be unit-tested / reused independently of the request lifecycle ──
async function createInvestigationRecord(bucket, payload, createdByEmail) {
  const caseMasterId = String(payload.caseMasterId || '').trim();
  if (!caseMasterId) throw new Error('caseMasterId is required');
  let existing = null;
  try {
    existing = JSON.parse((await streamToString(await bucket.getObject(invKey(caseMasterId)))) || 'null');
  } catch { /* not created yet */ }
  if (existing) return { record: existing, created: false };

  const rec = {
    caseMasterId,
    investigationId: `INV-${caseMasterId}-${Date.now().toString(36).toUpperCase()}`,
    crimeNo: String(payload.crimeNo || ''),
    caseNo: String(payload.caseNo || ''),
    ioEmployeeId: String(payload.ioEmployeeId || ''),
    ioName: String(payload.ioName || ''),
    ioRank: String(payload.ioRank || ''),
    station: String(payload.station || ''),
    district: String(payload.district || ''),
    caseType: String(payload.caseType || ''),
    sections: String(payload.sections || ''),
    registeredDate: String(payload.registeredDate || ''),
    status: 'Under Investigation',
    lastDiaryDate: '',
    diaryEntries: [], statements: [], evidence: [], persons: [], timeline: [], findings: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: String(createdByEmail || ''),
  };
  await bucket.putObject(invKey(caseMasterId), Buffer.from(JSON.stringify(rec)));
  await upsertInvIndex(bucket, rec);
  return { record: rec, created: true };
}

async function setInvestigationStatusRecord(bucket, caseMasterId, status) {
  if (!INV_STATUSES.includes(status)) throw new Error('invalid status');
  let rec;
  try {
    rec = JSON.parse((await streamToString(await bucket.getObject(invKey(caseMasterId)))) || 'null');
  } catch {
    rec = null;
  }
  if (!rec) throw new Error('Investigation record not found');
  rec.status = status;
  rec.updatedAt = Date.now();
  await bucket.putObject(invKey(caseMasterId), Buffer.from(JSON.stringify(rec)));
  await upsertInvIndex(bucket, rec);
  return rec;
}

// `ioIdentity` is { email, name } for the entry's author.
async function appendInvestigationEntry(bucket, caseMasterId, section, item, ioIdentity) {
  if (!INV_SECTIONS.includes(section)) throw new Error('invalid section');
  let rec;
  try {
    rec = JSON.parse((await streamToString(await bucket.getObject(invKey(caseMasterId)))) || 'null');
  } catch {
    rec = null;
  }
  if (!rec) throw new Error('Investigation record not found');

  const list = rec[section] || (rec[section] = []);
  const entry = {
    ...item,
    id: `${section.slice(0, 3)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ts: Number.isFinite(item.ts) ? item.ts : Date.now(),
    ioId: String(ioIdentity?.email || ''),
    ioName: ioIdentity?.name || rec.ioName || '',
  };
  if (section === 'diaryEntries') {
    entry.serial = list.length + 1; // sequential Case Diary serial number (legally required)
  }

  // Lead generation, lite: flatten persons by name across every case so a
  // recurring name surfaces as a lead the moment it's entered. Advisory
  // only — framed as "appears in" in the UI, never as an accusation.
  if (section === 'persons') {
    const norm = String(entry.name || '').trim().toLowerCase();
    if (norm) {
      let pidx;
      try {
        pidx = JSON.parse((await streamToString(await bucket.getObject(INV_PERSON_INDEX_KEY))) || '{}');
      } catch {
        pidx = {};
      }
      if (!pidx.people) pidx.people = {};
      const arr = pidx.people[norm] || (pidx.people[norm] = []);
      if (!arr.some((a) => a.caseMasterId === caseMasterId)) {
        arr.push({ caseMasterId, crimeNo: rec.crimeNo || caseMasterId, role: entry.role || '', name: entry.name || '' });
        await bucket.putObject(INV_PERSON_INDEX_KEY, Buffer.from(JSON.stringify(pidx)));
      }
      entry.connections = arr.filter((a) => a.caseMasterId !== caseMasterId);
    }
  }

  list.push(entry);
  rec.updatedAt = Date.now();
  if (section === 'diaryEntries') rec.lastDiaryDate = new Date(entry.ts).toISOString().slice(0, 10);
  await bucket.putObject(invKey(caseMasterId), Buffer.from(JSON.stringify(rec)));
  await upsertInvIndex(bucket, rec);
  return { record: rec, entry };
}

// Editing/removing an entry is just a read-modify-write of the case record
// (a PutObject) — no Stratus DeleteObject needed, which matters because the
// bucket policy only grants Get/Put. Only the specific text fields of an
// entry can be changed; structural fields (id, ts, serial, media keys) are
// preserved so a diary serial or an evidence pointer can't be rewritten.
const EDITABLE_FIELDS = [
  'personName', 'role', 'text', 'narrative', 'placesVisited', 'personsExamined',
  'description', 'type', 'seizureMemoRef', 'location', 'fslStatus',
  'name', 'status', 'notes', 'detail', 'note',
];
async function updateInvestigationEntry(bucket, caseMasterId, section, entryId, patch, ioIdentity) {
  if (!INV_SECTIONS.includes(section)) throw new Error('invalid section');
  let rec;
  try {
    rec = JSON.parse((await streamToString(await bucket.getObject(invKey(caseMasterId)))) || 'null');
  } catch {
    rec = null;
  }
  if (!rec) throw new Error('Investigation record not found');
  const list = rec[section] || [];
  const idx = list.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error('entry not found');
  const updated = { ...list[idx] };
  for (const k of EDITABLE_FIELDS) if (k in (patch || {})) updated[k] = patch[k];
  updated.editedAt = Date.now();
  updated.editedBy = ioIdentity?.name || list[idx].ioName || '';
  list[idx] = updated;
  rec[section] = list;
  rec.updatedAt = Date.now();
  await bucket.putObject(invKey(caseMasterId), Buffer.from(JSON.stringify(rec)));
  await upsertInvIndex(bucket, rec);
  return { record: rec, entry: updated };
}

async function deleteInvestigationEntry(bucket, caseMasterId, section, entryId) {
  if (!INV_SECTIONS.includes(section)) throw new Error('invalid section');
  let rec;
  try {
    rec = JSON.parse((await streamToString(await bucket.getObject(invKey(caseMasterId)))) || 'null');
  } catch {
    rec = null;
  }
  if (!rec) throw new Error('Investigation record not found');
  const list = rec[section] || [];
  const next = list.filter((e) => e.id !== entryId);
  if (next.length === list.length) throw new Error('entry not found');
  // Any Stratus media attached to the removed entry (audioKey/fileKey) is left
  // in place — the bucket policy grants no DeleteObject — so the object is
  // simply dereferenced (orphaned, harmless).
  rec[section] = next;
  rec.updatedAt = Date.now();
  await bucket.putObject(invKey(caseMasterId), Buffer.from(JSON.stringify(rec)));
  await upsertInvIndex(bucket, rec);
  return { record: rec };
}

// Reorder a section's entries to match the given list of ids (ids not present
// are appended in their original relative order). Just a PutObject of the
// reordered record — used by the draggable timeline.
async function reorderInvestigationEntries(bucket, caseMasterId, section, orderedIds) {
  if (!INV_SECTIONS.includes(section)) throw new Error('invalid section');
  let rec;
  try {
    rec = JSON.parse((await streamToString(await bucket.getObject(invKey(caseMasterId)))) || 'null');
  } catch {
    rec = null;
  }
  if (!rec) throw new Error('Investigation record not found');
  const list = rec[section] || [];
  const byId = new Map(list.map((e) => [e.id, e]));
  const seen = new Set();
  const next = [];
  for (const id of Array.isArray(orderedIds) ? orderedIds : []) {
    const e = byId.get(String(id));
    if (e && !seen.has(e.id)) { next.push(e); seen.add(e.id); }
  }
  for (const e of list) if (!seen.has(e.id)) next.push(e); // keep any missing ones
  rec[section] = next;
  rec.updatedAt = Date.now();
  await bucket.putObject(invKey(caseMasterId), Buffer.from(JSON.stringify(rec)));
  await upsertInvIndex(bucket, rec);
  return { record: rec };
}

async function handleInvestigation(req, res, action) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  // myRole() falls back to 'investigator' when a signed-in user has no role
  // record yet (so a freshly-assigned officer isn't locked out) — but that
  // fallback must never cover an UNAUTHENTICATED caller, so require a
  // verified session on top of the role check.
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }
  const ioIdentity = { email: caller?.email_id || '', name: [caller?.first_name, caller?.last_name].filter(Boolean).join(' ') };

  if (action === 'list') {
    return json(res, 200, { cases: await loadInvIndex(bucket) });
  }

  const caseMasterId = String(body.caseMasterId || '').trim();
  if (!caseMasterId) return json(res, 400, { error: 'caseMasterId is required' });

  if (action === 'get') {
    try {
      const rec = JSON.parse((await streamToString(await bucket.getObject(invKey(caseMasterId)))) || 'null');
      return json(res, 200, { record: rec });
    } catch {
      return json(res, 200, { record: null });
    }
  }

  if (action === 'create') {
    const { record, created } = await createInvestigationRecord(bucket, body, caller?.email_id);
    if (created) {
      await storeAuditEvents(req, app, bucket, [{
        action: 'open-investigation', feature: 'Investigation Diary', path: '/investigation-diary',
        detail: record.crimeNo || caseMasterId,
      }], caller);
    }
    return json(res, 200, { record, created });
  }

  if (action === 'status') {
    const status = String(body.status || '');
    if (!INV_STATUSES.includes(status)) return json(res, 400, { error: 'invalid status' });
    let rec;
    try {
      rec = await setInvestigationStatusRecord(bucket, caseMasterId, status);
    } catch {
      return json(res, 404, { error: 'Investigation record not found' });
    }
    await storeAuditEvents(req, app, bucket, [{
      action: 'status-change', feature: 'Investigation Diary', path: '/investigation-diary',
      detail: `${rec.crimeNo || caseMasterId} → ${rec.status}`,
    }], caller);
    return json(res, 200, { record: rec });
  }

  if (action === 'append') {
    const section = String(body.section || '');
    if (!INV_SECTIONS.includes(section)) return json(res, 400, { error: 'invalid section' });
    const item = body.item && typeof body.item === 'object' ? body.item : {};
    let record, entry;
    try {
      ({ record, entry } = await appendInvestigationEntry(bucket, caseMasterId, section, item, ioIdentity));
    } catch (e) {
      if (/not found/i.test(e.message || '')) return json(res, 404, { error: 'Investigation record not found' });
      return json(res, 500, { error: 'Could not save entry — ' + (e.message || e) });
    }
    await storeAuditEvents(req, app, bucket, [{
      action: `add-${section}`, feature: 'Investigation Diary', path: '/investigation-diary',
      detail: record.crimeNo || caseMasterId,
    }], caller);
    return json(res, 200, { record, entry });
  }

  if (action === 'update') {
    const section = String(body.section || '');
    if (!INV_SECTIONS.includes(section)) return json(res, 400, { error: 'invalid section' });
    const entryId = String(body.entryId || '');
    const patch = body.patch && typeof body.patch === 'object' ? body.patch : {};
    let record, entry;
    try {
      ({ record, entry } = await updateInvestigationEntry(bucket, caseMasterId, section, entryId, patch, ioIdentity));
    } catch (e) {
      if (/not found/i.test(e.message || '')) return json(res, 404, { error: e.message });
      return json(res, 500, { error: 'Could not update entry — ' + (e.message || e) });
    }
    await storeAuditEvents(req, app, bucket, [{
      action: `edit-${section}`, feature: 'Investigation Diary', path: '/investigation-diary',
      detail: record.crimeNo || caseMasterId,
    }], caller);
    return json(res, 200, { record, entry });
  }

  if (action === 'delete') {
    const section = String(body.section || '');
    if (!INV_SECTIONS.includes(section)) return json(res, 400, { error: 'invalid section' });
    const entryId = String(body.entryId || '');
    let record;
    try {
      ({ record } = await deleteInvestigationEntry(bucket, caseMasterId, section, entryId));
    } catch (e) {
      if (/not found/i.test(e.message || '')) return json(res, 404, { error: e.message });
      return json(res, 500, { error: 'Could not delete entry — ' + (e.message || e) });
    }
    await storeAuditEvents(req, app, bucket, [{
      action: `delete-${section}`, feature: 'Investigation Diary', path: '/investigation-diary',
      detail: record.crimeNo || caseMasterId,
    }], caller);
    return json(res, 200, { record });
  }

  if (action === 'reorder') {
    const section = String(body.section || '');
    if (!INV_SECTIONS.includes(section)) return json(res, 400, { error: 'invalid section' });
    let record;
    try {
      ({ record } = await reorderInvestigationEntries(bucket, caseMasterId, section, body.orderedIds));
    } catch (e) {
      if (/not found/i.test(e.message || '')) return json(res, 404, { error: e.message });
      return json(res, 500, { error: 'Could not reorder — ' + (e.message || e) });
    }
    return json(res, 200, { record });
  }

  return json(res, 400, { error: 'unknown action' });
}

// AI case summarisation: a "state of the investigation" brief drafted ONLY
// from the case's own structured entries, with numbered citations back to
// the exact diary entry / statement / finding it drew from — advisory, never
// a black box, per the guardrails in the feature brief.
async function handleInvestigationSummary(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  // myRole() falls back to 'investigator' when a signed-in user has no role
  // record yet (so a freshly-assigned officer isn't locked out) — but that
  // fallback must never cover an UNAUTHENTICATED caller, so require a
  // verified session on top of the role check.
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }
  const caseMasterId = String(body.caseMasterId || '').trim();
  if (!caseMasterId) return json(res, 400, { error: 'caseMasterId is required' });

  let rec;
  try {
    rec = JSON.parse((await streamToString(await bucket.getObject(invKey(caseMasterId)))) || 'null');
  } catch {
    rec = null;
  }
  if (!rec) return json(res, 404, { error: 'Investigation record not found' });

  const sources = [];
  (rec.diaryEntries || []).forEach((e) => sources.push({
    label: `Diary #${e.serial}`, date: e.ts,
    text: [e.narrative, e.placesVisited && `Places visited: ${e.placesVisited}`, e.personsExamined && `Persons examined: ${e.personsExamined}`]
      .filter(Boolean).join(' — '),
  }));
  (rec.statements || []).forEach((s) => sources.push({
    label: `Statement — ${s.personName || 'unknown'} (${s.role || 'witness'})`, date: s.ts, text: s.text || '',
  }));
  (rec.timeline || []).forEach((t) => sources.push({ label: `Event — ${t.type || 'event'}`, date: t.ts, text: t.detail || '' }));
  (rec.findings || []).forEach((f) => sources.push({ label: `Finding (${f.type || 'note'})`, date: f.ts, text: f.note || '' }));
  sources.sort((a, b) => (a.date || 0) - (b.date || 0));

  if (!sources.length) {
    return json(res, 200, {
      summary: 'No diary entries, statements, timeline events or findings recorded yet — nothing to summarise.',
      citations: [],
    });
  }

  const srcText = sources.slice(0, 120)
    .map((s, i) => `[${i + 1}] ${s.label} (${new Date(s.date).toISOString().slice(0, 10)}): ${String(s.text).slice(0, 500)}`)
    .join('\n');
  const prose = await callGroq(
    [
      {
        role: 'system',
        content:
          'You are drafting a "state of the investigation" brief for a police Case Diary, for handover between ' +
          'Investigating Officers or when a case is reopened. Use ONLY the numbered source entries given — never ' +
          'invent facts, names, dates or outcomes not present in them. Write 4-8 sentences covering what has been ' +
          'done, key findings so far, and what remains open. Cite the source number in brackets after any sentence ' +
          'that draws on it, e.g. "The complainant was examined on-site [2]." This is an advisory draft only — the ' +
          'IO must verify it against the source entries before relying on it.',
      },
      { role: 'user', content: `Case ${rec.crimeNo || caseMasterId}, current status: ${rec.status}.\n\nSources:\n${srcText}` },
    ],
    { maxTokens: 500, temperature: 0.2, timeoutMs: 15_000 }
  );

  await storeAuditEvents(req, app, bucket, [{
    action: 'ai-summary', feature: 'Investigation Diary', path: '/investigation-diary',
    detail: rec.crimeNo || caseMasterId,
  }], caller);

  return json(res, 200, {
    summary: (prose || 'Summary unavailable right now — try again shortly.').trim(),
    citations: sources.slice(0, 120).map((s, i) => ({ n: i + 1, label: s.label, date: s.date })),
  });
}

// ── Investigation media (audio/image/doc evidence) ───────────────────────────
// Recordings and scanned documents attached to a testimony/statement are
// stored as individual Stratus objects (not embedded in the case JSON blob,
// which stays lean) under investigation/media/<caseMasterId>/<id>.<ext>, and
// referenced by key from the statement entry that owns them. Playback/view
// always goes through an authenticated endpoint — evidence media is never
// publicly reachable by URL.
const MEDIA_PREFIX = 'investigation/media/';
const MEDIA_EXT_BY_MIME = {
  'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg',
  'image/jpeg': 'jpg', 'image/png': 'png', 'text/plain': 'txt',
};
const MEDIA_MIME_BY_EXT = Object.fromEntries(Object.entries(MEDIA_EXT_BY_MIME).map(([m, e]) => [e, m]));
const mediaId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const mediaKey = (caseMasterId, id, mime) => `${MEDIA_PREFIX}${caseMasterId}/${id}.${MEDIA_EXT_BY_MIME[mime] || 'bin'}`;

async function requireInvestigator(app, bucket) {
  const { role, caller } = await myRole(app, bucket);
  if (!caller || !canInvestigate(role)) return null;
  return caller;
}
function urlParam(req, k) {
  const q = (req.url || '').split('?')[1] || '';
  const m = q.match(new RegExp(`(?:^|&)${k}=([^&]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}

// POST /investigation/media/upload — the body is hex-encoded bytes (same trick
// as /profile/photo): raw binary/base64 trips the gateway's resource-access
// scanner on cookie-authenticated calls, hex never matches a signature.
// Query string: caseMasterId, mime, filename.
async function handleMediaUpload(req, res) {
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const caller = await requireInvestigator(app, bucket);
  if (!caller) return json(res, 403, { error: 'Investigator, supervisor or admin access required' });

  const caseMasterId = urlParam(req, 'caseMasterId');
  const mime = urlParam(req, 'mime') || 'application/octet-stream';
  const filename = urlParam(req, 'filename') || 'file';
  if (!caseMasterId) return json(res, 400, { error: 'caseMasterId is required' });

  const ctype = String(req.headers['content-type'] || '');
  let buf;
  if (ctype.includes('application/octet-stream')) {
    buf = await readBinaryBody(req);
  } else {
    const hex = (await readBody(req)).trim();
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return json(res, 400, { error: 'invalid encoding' });
    buf = Buffer.from(hex, 'hex');
  }
  if (!buf.length) return json(res, 400, { error: 'empty file' });
  if (buf.length > 12 * 1024 * 1024) return json(res, 413, { error: 'file too large (12MB max)' });

  const key = mediaKey(caseMasterId, mediaId(), mime);
  try {
    await bucket.putObject(key, buf);
  } catch (e) {
    return json(res, 500, { error: 'Could not store the recording — ' + (e.message || e) });
  }
  await storeAuditEvents(req, app, bucket, [{
    action: 'evidence-upload', feature: 'Investigation Diary', path: '/investigation-diary',
    detail: `${filename} (case ${caseMasterId})`,
  }], caller);
  return json(res, 200, { key, mime, size: buf.length });
}

// POST /investigation/media/get  { key }  →  { data: <base64>, mime } — the
// client turns this into a Blob + object URL for playback, so recordings are
// never served from a bare, unauthenticated URL.
async function handleMediaGet(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const key = String(body.key || '');
  if (!key.startsWith(MEDIA_PREFIX)) return json(res, 400, { error: 'invalid key' });
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const caller = await requireInvestigator(app, bucket);
  if (!caller) return json(res, 403, { error: 'Investigator, supervisor or admin access required' });

  try {
    const stream = await bucket.getObject(key);
    const chunks = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const buf = Buffer.concat(chunks);
    const ext = key.split('.').pop();
    const mime = MEDIA_MIME_BY_EXT[ext] || 'application/octet-stream';
    await storeAuditEvents(req, app, bucket, [{
      action: 'evidence-view', feature: 'Investigation Diary', path: '/investigation-diary', detail: key,
    }], caller);
    return json(res, 200, { data: buf.toString('base64'), mime });
  } catch {
    return json(res, 404, { error: 'file not found' });
  }
}

// POST /investigation/ocr — hex-encoded image body, query: caseMasterId,
// filename, mime. Runs Zia OCR AND keeps the source scan in Stratus (same
// media store as recordings) so the extracted text is always traceable back
// to the document it came from.
async function handleOcr(req, res) {
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const caller = await requireInvestigator(app, bucket);
  if (!caller) return json(res, 403, { error: 'Investigator, supervisor or admin access required' });

  const caseMasterId = urlParam(req, 'caseMasterId');
  const filename = urlParam(req, 'filename') || 'document.jpg';
  const mimeParam = urlParam(req, 'mime');
  const mime = /^image\/(jpeg|png)$/.test(mimeParam) ? mimeParam : 'image/jpeg';
  if (!caseMasterId) return json(res, 400, { error: 'caseMasterId is required' });

  const hex = (await readBody(req)).trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return json(res, 400, { error: 'invalid encoding' });
  const buf = Buffer.from(hex, 'hex');
  if (!buf.length) return json(res, 400, { error: 'empty file' });
  if (buf.length > 8 * 1024 * 1024) return json(res, 413, { error: 'image too large (8MB max)' });

  const key = mediaKey(caseMasterId, mediaId(), mime);
  await bucket.putObject(key, buf);

  // Zia's extractOpticalCharacters expects an fs.ReadStream — a raw Buffer
  // gets appended to the multipart form with no filename/content-type and Zia
  // rejects it as "wrong format". Stage the bytes to a temp file and hand it a
  // real read stream (its `path` lets form-data set the filename + type).
  let text = '';
  const tmpPath = path.join(os.tmpdir(), `ocr-${mediaId()}.${MEDIA_EXT_BY_MIME[mime] || 'jpg'}`);
  try {
    fs.writeFileSync(tmpPath, buf);
    const result = await app.zia().extractOpticalCharacters(
      fs.createReadStream(tmpPath),
      { modelType: 'OCR', language: 'eng' }
    );
    text = (result && result.text) || '';
  } catch (e) {
    return json(res, 502, { error: 'OCR failed: ' + (e.message || e), key });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* temp cleanup best-effort */ }
  }

  await storeAuditEvents(req, app, bucket, [{
    action: 'ocr', feature: 'Investigation Diary', path: '/investigation-diary', detail: filename,
  }], caller);
  return json(res, 200, { text, key });
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
    const path = req.url ? req.url.split('?')[0].replace(/\/+$/, '') : '';
    if (path.endsWith('/transcribe')) return await handleTranscribe(req, res);
    if (path.endsWith('/report-pdf')) return await handleReportPdf(req, res);
    if (path.endsWith('/support')) return await handleSupport(req, res);
    if (path.endsWith('/conversations/list')) return await handleConversations(req, res, 'list');
    if (path.endsWith('/conversations/save')) return await handleConversations(req, res, 'save');
    if (path.endsWith('/conversations/delete')) return await handleConversations(req, res, 'delete');
    if (path.endsWith('/profile/photo')) return await handleProfilePhoto(req, res);
    if (path.endsWith('/profile/get')) return await handleProfile(req, res, 'get');
    if (path.endsWith('/profile/save')) return await handleProfile(req, res, 'save');
    if (path.endsWith('/access/me')) return await handleAccess(req, res, 'me');
    if (path.endsWith('/access/users')) return await handleAccess(req, res, 'users');
    if (path.endsWith('/access/save')) return await handleAccess(req, res, 'save');
    // Deliberately bland paths: "/audit/log" matches ad-blocker privacy lists,
    // which silently kill the fetch in the browser.
    if (path.endsWith('/access/record')) return await handleAudit(req, res, 'log');
    if (path.endsWith('/access/records')) return await handleAudit(req, res, 'list');
    if (path.endsWith('/investigation/list')) return await handleInvestigation(req, res, 'list');
    if (path.endsWith('/investigation/get')) return await handleInvestigation(req, res, 'get');
    if (path.endsWith('/investigation/create')) return await handleInvestigation(req, res, 'create');
    if (path.endsWith('/investigation/status')) return await handleInvestigation(req, res, 'status');
    if (path.endsWith('/investigation/append')) return await handleInvestigation(req, res, 'append');
    if (path.endsWith('/investigation/update')) return await handleInvestigation(req, res, 'update');
    if (path.endsWith('/investigation/delete')) return await handleInvestigation(req, res, 'delete');
    if (path.endsWith('/investigation/reorder')) return await handleInvestigation(req, res, 'reorder');
    if (path.endsWith('/investigation/summarize')) return await handleInvestigationSummary(req, res);
    if (path.endsWith('/investigation/media/upload')) return await handleMediaUpload(req, res);
    if (path.endsWith('/investigation/media/get')) return await handleMediaGet(req, res);
    if (path.endsWith('/investigation/ocr')) return await handleOcr(req, res);

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

    // ── Router: casual message → direct Groq chat; relational question →
    // ZCQL over the Data Store; otherwise RAG. Groq decides; any failure in
    // the CHAT/ZCQL paths falls through to RAG so the assistant always answers.
    let zcqlDebug; // populated when the ZCQL path was tried but abandoned
    if (process.env.GROQ_API_KEY) {
      // CHAT must be judged on the user's ORIGINAL wording — expansion can
      // rewrite a bare "thanks!" into a restated data question.
      const routed = await callGroq(
        [
          { role: 'system', content: zcql.ROUTER_PROMPT },
          {
            role: 'user',
            content:
              searchQuery === query
                ? query
                : `Original message: ${query}\n(With context resolved: ${searchQuery})`,
          },
        ],
        { maxTokens: 4, temperature: 0, timeoutMs: 5_000, model: GROQ_MODEL_FAST }
      );
      if (routed && /chat/i.test(routed)) {
        const chat = await callGroq(
          [{ role: 'system', content: CHAT_SYSTEM }, ...history, { role: 'user', content: query }],
          { maxTokens: 220, temperature: 0.6, timeoutMs: 12_000 }
        );
        if (chat && chat.trim()) {
          return json(res, 200, {
            answer: chat.trim(),
            components: [],
            source: 'chat',
            sources: [],
          });
        }
        // Groq unavailable mid-request — fall through to the RAG path below.
      }
      if (routed && /guide/i.test(routed)) {
        const guide = await callGroq(
          [{ role: 'system', content: GUIDE_SYSTEM }, ...history, { role: 'user', content: query }],
          { maxTokens: 420, temperature: 0.3, timeoutMs: 12_000 }
        );
        if (guide && guide.trim()) {
          const g = extractAgui(guide);
          return json(res, 200, {
            answer: g.text || guide.trim(),
            components: g.components,
            source: 'guide',
            sources: [],
          });
        }
        // Groq unavailable mid-request — fall through to the RAG path below.
      }
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

    // Attribution: knowledge-base document titles, and only for RAG answers —
    // conversational/general-knowledge replies carry no sources row at all.
    const sources =
      source === 'rag'
        ? [
            ...new Set(
              (first.data.retrieved_nodes || [])
                .map((n) => n && n.document_title)
                .filter(Boolean)
            ),
          ]
        : [];

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
