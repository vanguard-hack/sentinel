'use strict';

const catalystSDK = require('zcatalyst-sdk-node');
const zcql = require('./zcql');
const redaction = require('./redaction');
const vision = require('./vision');
const attribution = require('./sources');
const memory = require('./memory');
const assistantTools = require('./tools');
const integrity = require('./integrity');
const grounding = require('./grounding');
const guard = require('./guard');
const forecasting = require('./forecast');
const i18n = require('./i18n');
const statutory = require('./statutory');
const legalKb = require('./legal_kb.json');
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
 *
 * Officer memory (see memory.js) needs a Cache segment and three NoSQL tables
 * created in the console; without them the assistant behaves exactly as it did
 * before memory existed. Optional overrides:
 *   MEMORY_IDLE_MINUTES   idle window that ends a session, default 45
 *   MEMORY_KB_URL         QuickML endpoint that creates a KB document
 *   MEMORY_KB_DELETE      QuickML KB delete endpoint, {id} substituted
 *
 * LLM providers. Every model call goes through callLLM, which tries providers
 * in order and takes the first usable answer, so one provider being down
 * degrades an answer rather than removing it:
 *   GROQ_API_KEY          provider 1 (fast, cheap) — already in use
 *   ANTHROPIC_API_KEY     provider 2 (Claude) — dormant until set
 *   CLAUDE_MODEL          default claude-opus-5
 *   CLAUDE_MODEL_FAST     default = CLAUDE_MODEL; set claude-haiku-4-5 to cut
 *                         the cost of routing/expansion calls
 *   LLM_PROVIDER_ORDER    default "groq,claude"; use "claude,groq" to put
 *                         answer quality ahead of latency and cost
 *
 * Access control:
 *   BLOCKED_IPS           comma-separated exact addresses and/or prefixes
 *                         (a trailing "." or ":" makes an entry a prefix)
 *   RATE_LIMIT_PER_MIN            default 120 per officer
 *   RATE_LIMIT_METERED_PER_MIN    default 20, for routes that cost per call
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
// fenced JSON block describing typed components. The app owns the rendering;
// the agent only proposes typed specs, and only from the vocabulary in
// AGUI_TYPES — anything else is dropped rather than rendered.
// Two-pass generative UI. Appending component instructions to the user's query
// polluted the retrieval embedding (short questions stopped matching their
// documents), so pass 1 sends the query CLEAN, and pass 2 — run only when the
// answer looks data-shaped — asks the model to transform that answer text into
// components. Pass 2's retrieval is irrelevant; the data is in the prompt.
// The component vocabulary, in one place.
//
// Two lanes describe it to the model — the transform pass and the tool loop —
// and a vocabulary written twice is one that drifts: a shape added for one lane
// is silently unavailable to the other, and nothing fails, the model just never
// proposes it.
const AGUI_SHAPES =
  'Each component is ' +
  '{"type":"bar-chart"|"pie-chart","title":s,"data":[{"label":s,"value":n}]} or ' +
  '{"type":"line-chart","title":s,"data":[{"label":s,"value":n}]} (a value over ' +
  'ordered time periods — months, quarters, years) or ' +
  '{"type":"multi-line-chart","title":s,"series":[{"name":s,"points":[{"label":s,"value":n}]}]} ' +
  '(several things compared over the SAME periods — every series must have the same ' +
  'labels in the same order) or ' +
  '{"type":"stacked-bar-chart","title":s,"data":[{"label":s,"parts":[{"name":s,"value":n}]}]} ' +
  '(a total broken into named parts per category) or ' +
  '{"type":"heat-grid","title":s,"rows":[s],"cols":[s],"values":[[n]]} (two dimensions ' +
  'crossed — day against hour, district against crime type; values must be a grid ' +
  'rows x cols) or ' +
  '{"type":"scatter-plot","title":s,"xLabel":s,"yLabel":s,"data":[{"x":n,"y":n,"label":s}]} ' +
  '(two measures against each other, to show a relationship) or ' +
  '{"type":"funnel","title":s,"data":[{"label":s,"value":n}]} (stages that narrow — ' +
  'registered, investigated, chargesheeted, convicted) or ' +
  '{"type":"pyramid","title":s,"data":[{"label":s,"value":n}]} (a ranked hierarchy of ' +
  'severity or seniority) or ' +
  '{"type":"sankey","title":s,"nodes":[{"id":s,"label":s}],' +
  '"links":[{"source":s,"target":s,"value":n}]} (where quantity FLOWS between things — ' +
  'money between accounts, cases between statuses or stations) or ' +
  '{"type":"table","title":s,"columns":[s],"rows":[[cells]]} or ' +
  '{"type":"cards","title":s,"items":[{"title":s,"subtitle":s,"body":s,"badge":s}]} or ' +
  '{"type":"geo-map","title":s,"data":[{"district":s,"value":n}]} (Karnataka district ' +
  'names — use when the data is per-district) or ' +
  '{"type":"network-graph","title":s,"nodes":[{"id":s,"label":s,"group":s}],' +
  '"links":[{"source":s,"target":s}]} (use for relationships between people/gangs/entities). ' +
  '\n';

const AGUI_TRANSFORM =
  'Convert the data in the TEXT below into ONE fenced ```agui code block of JSON ' +
  '{"components":[...]} where each component is ' +
  AGUI_SHAPES +
  'RULE: if the values are per Karnataka district, ALWAYS use geo-map (not bar-chart), ' +
  'with plain district names (e.g. "Bengaluru City", "Kalaburagi" — no DIST suffix). ' +
  'RULE: pick the shape that matches the QUESTION, not the one that is easiest. ' +
  'Ordered periods -> line-chart. Parts of a whole per category -> stacked-bar-chart. ' +
  'Two dimensions crossed -> heat-grid. Movement between things -> sankey. ' +
  'A plain ranking -> bar-chart. Never draw a line through fewer than three points. ' +
  'Choose the 1-2 components that best fit the data. ' +
  // The renderer normalises stray markup anyway, but keeping it out of the
  // JSON in the first place gives cleaner cells and shorter payloads.
  'CELL FORMAT: cell values must be PLAIN TEXT — no HTML tags (never <br>), no ' +
  'markdown bold/italic markers, no bullet characters. Keep each cell to a short ' +
  'phrase; if a cell would need several points, split it into separate rows. ' +
  'Output ONLY the fenced block.' +
  '\n\nTEXT:\n';

// ── Groq (fallback LLM + query expansion) ──────────────────────────────────
// Used three ways, all best-effort (RAG-only behaviour if the key is absent):
//   1. expand the user's question into a self-contained one before retrieval
//   2. answer from general knowledge when RAG comes back negative
//   3. transform answers into agui components (faster + more reliable than a
//      second RAG round-trip)
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Groq decommissioned the llama-3.x models (they now 404), so the defaults are
// the current replacements. Rate limits are per model: high-volume/simple calls
// (routing, expansion, prose-from-rows, component transform) run on the fast
// model so the big model's budget is reserved for summaries, ZCQL generation
// and knowledge fallbacks.
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_MODEL_FAST = process.env.GROQ_MODEL_FAST || 'qwen/qwen3.6-27b';

async function callGroq(messages, { maxTokens = 1024, temperature = 0.3, timeoutMs = 12_000, model = GROQ_MODEL } = {}) {
  if (!process.env.GROQ_API_KEY) return null;
  // One retry on 429: the free tier has a tokens-per-minute cap that a single
  // multi-call question (router + generator + prose) can trip. A third attempt
  // is reserved for the model-downgrade path below.
  let waited = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // gpt-oss are reasoning models: reasoning tokens spend from max_tokens
      // BEFORE any content, so a tight content budget must be topped up or the
      // reply comes back empty. qwen3 can switch reasoning off entirely, so
      // there max_tokens keeps meaning "content tokens".
      const payload = { model, messages, temperature, max_tokens: maxTokens };
      if (model.startsWith('openai/gpt-oss')) {
        payload.reasoning_effort = 'low';
        payload.max_tokens = maxTokens + 768;
      } else if (model.startsWith('qwen/')) {
        payload.reasoning_effort = 'none';
      }
      const r = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status === 404 || r.status === 400) {
        // model_not_found (Groq retires models without notice) — try the other
        // tier once rather than failing the feature.
        if (model !== GROQ_MODEL_FAST) { model = GROQ_MODEL_FAST; continue; }
        return null;
      }
      if (r.status === 429) {
        // Only a SHORT cool-off (per-minute cap) is worth waiting out — once. A
        // long retry-after means a per-day cap: retrying the same model is
        // futile, so downgrade to the fast model (its cap is separate) instead
        // of failing the feature outright.
        const retry = (parseFloat(r.headers.get('retry-after')) || 3) * 1000;
        if (retry <= 9_000 && !waited) {
          waited = true;
          await new Promise((s) => setTimeout(s, Math.min(retry, 8_000)));
          continue;
        }
        if (model !== GROQ_MODEL_FAST) { model = GROQ_MODEL_FAST; continue; }
        return null;
      }
      const d = await r.json().catch(() => ({}));
      return r.ok ? (d.choices && d.choices[0] && d.choices[0].message.content) || null : null;
    } catch {
      return null; // timeout / network — callers treat null as "skip"
    }
  }
  return null;
}

// ── Claude (Anthropic) ─────────────────────────────────────────────────────
//
// The second provider. Groq is fast and cheap and answers first; Claude is
// what the assistant falls back to when Groq is down, rate-limited, or has
// retired a model out from under us — which has happened here before. Two
// providers means an outage at one degrades the answer rather than removing
// it.
//
// Dormant until ANTHROPIC_API_KEY is set: with no key this returns null and
// the chain behaves exactly as it did with Groq alone.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
// The cheap lane (routing, expansion, one-word classification). Defaults to
// the same model; set CLAUDE_MODEL_FAST=claude-haiku-4-5 to cut the cost of
// the high-volume calls.
const CLAUDE_MODEL_FAST = process.env.CLAUDE_MODEL_FAST || CLAUDE_MODEL;
let anthropicClient = null;

// Anthropic takes the system prompt as a top-level parameter, not as a turn in
// the messages array, and the array has to begin with a user turn. Our callers
// build OpenAI-shaped conversations — a system message first, sometimes a
// memory system turn mid-history — so they are translated rather than passed
// through.
function toAnthropic(messages) {
  const system = [];
  const turns = [];
  for (const m of messages) {
    if (!m || !m.content) continue;
    if (m.role === 'system') { system.push(String(m.content)); continue; }
    turns.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) });
  }
  // A conversation may not open on an assistant turn.
  while (turns.length && turns[0].role === 'assistant') turns.shift();
  return { system: system.join('\n\n'), turns };
}

async function callClaude(messages, { maxTokens = 1024, timeoutMs = 12_000, tier = 'main' } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const { system, turns } = toAnthropic(messages);
  if (!turns.length) return null;
  try {
    if (!anthropicClient) {
      const Anthropic = require('@anthropic-ai/sdk');
      anthropicClient = new (Anthropic.default || Anthropic)();
    }
    const res = await anthropicClient.messages.create(
      {
        model: tier === 'fast' ? CLAUDE_MODEL_FAST : CLAUDE_MODEL,
        // Thinking is on by default and its tokens come out of this budget, so
        // a caller asking for 40 tokens of routing output would otherwise be
        // truncated before any content — the same trap the gpt-oss branch
        // above documents. Effort is held low rather than thinking disabled:
        // disabling it on Opus 5 can put a tool call into the visible text.
        max_tokens: Math.max(1024, maxTokens + 768),
        output_config: { effort: 'low' },
        ...(system ? { system } : {}),
        messages: turns,
      },
      { timeout: timeoutMs }
    );
    const text = (res.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return text || null;
  } catch (e) {
    // Typed, most specific first — a bad key is worth a loud log, a rate limit
    // is not. Either way the caller gets null and carries on.
    const Anthropic = require('@anthropic-ai/sdk');
    const A = Anthropic.default || Anthropic;
    if (e instanceof A.AuthenticationError) console.error('claude: key rejected');
    else if (e instanceof A.RateLimitError) console.warn('claude: rate limited');
    else if (e instanceof A.APIError) console.warn('claude: api error', e.status);
    return null;
  }
}

// ── Provider chain ─────────────────────────────────────────────────────────
//
// Every LLM call in this function goes through here. Providers are tried in
// order and the first usable answer wins; a provider that is unconfigured,
// down, rate-limited or slow returns null and the next one is asked.
//
// Order is configurable because which provider should lead is an operational
// decision, not a code one: LLM_PROVIDER_ORDER=claude,groq puts answer quality
// first, the default puts latency and cost first.
const PROVIDERS = { groq: callGroq, claude: callClaude };
const PROVIDER_ORDER = (process.env.LLM_PROVIDER_ORDER || 'groq,claude')
  .split(',').map((p) => p.trim().toLowerCase()).filter((p) => PROVIDERS[p]);

async function callLLM(messages, opts = {}) {
  // The model option is Groq's own; translate it into a provider-neutral tier
  // so a fallback provider knows whether this was a cheap call or a big one.
  const tier = opts.model === GROQ_MODEL_FAST ? 'fast' : 'main';
  for (const name of PROVIDER_ORDER) {
    const out = await PROVIDERS[name](messages, { ...opts, tier });
    if (out !== null && String(out).trim()) return out;
  }
  return null;
}

// ── Tool loop ──────────────────────────────────────────────────────────────
//
// For questions that need more than one lookup. The router sends them here;
// everything else keeps the single-lane path it has always had, so this adds a
// capability without changing the behaviour of any question that already works.
//
// The loop is bounded twice over — a hard iteration cap and a wall-clock
// budget — because the model decides how many tools to call and an officer
// waiting on an answer does not. Hitting either bound is not an error: the
// model is asked to answer from what it has, which is nearly always enough.
const TOOL_MAX_ITERATIONS = Number(process.env.TOOL_MAX_ITERATIONS) || 6;
const TOOL_BUDGET_MS = Number(process.env.TOOL_BUDGET_MS) || 45_000;

// The schema, restated for the tool loop.
//
// It is NOT zcql.js's ZCQL_SYSTEM. That prompt drives a single-shot generator
// that must answer with a plan object, and pasting it in here made the model
// reply {"zcql": null, "reason": "..."} as its ANSWER — it followed the other
// protocol. Worse, without any schema at all the model simply invented tables:
// it queried FIR, Cases and Victims, none of which exist, and then reported
// zero to the officer. So the tables are named here, in the tool loop's own
// terms, with the relationships spelled out as the two-step this database
// actually requires.
const TOOL_SCHEMA_NOTE =
  'THE TABLES (query one at a time — this store has no JOINs):\n' +
  '  CaseMaster(CaseMasterID, CrimeNo, CrimeRegisteredDate, PoliceStationID, ' +
  'CaseCategoryID, GravityOffenceID, CrimeMajorHeadID, CrimeMinorHeadID, ' +
  'CaseStatusID, CourtID, PolicePersonID, BriefFacts) — one row per case/FIR\n' +
  '  Accused(AccusedMasterID, CaseMasterID, AccusedName, AgeYear, GenderID, PersonID)\n' +
  '  Victim(VictimMasterID, CaseMasterID, VictimName, AgeYear, GenderID)\n' +
  '  ComplainantDetails(ComplainantID, CaseMasterID, ComplainantName, AgeYear, GenderID)\n' +
  '  ArrestSurrender(ArrestSurrenderID, CaseMasterID, AccusedMasterID, ' +
  'ArrestSurrenderTypeID, ArrestSurrenderDate, ArrestSurrenderDistrictId)\n' +
  '  ChargesheetDetails(CSID, CaseMasterID, csdate, cstype)\n' +
  '  ActSectionAssociation(CaseMasterID, ActID, SectionID)\n' +
  '  Masters: District, Unit, Employee, Rank, CrimeHead, CrimeSubHead, Court, ' +
  'CaseStatusMaster, CaseCategory, GravityOffence — use lookup_reference for their ids.\n\n' +
  'KEY IDS: CaseCategoryID 1=FIR. CaseStatusID 1=Under Investigation, ' +
  '2=Charge Sheeted, 3=Pending Trial, 4=Convicted, 5=Acquitted, 6=Closed False, ' +
  '7=Closed Undetected. CrimeMajorHeadID 1=Against Body, 2=Against Property, ' +
  '3=Against Women, 4=Against Children, 5=Economic, 6=Cyber, 7=Narcotics, ' +
  '8=Public Order, 9=Traffic, 10=Other. GravityOffenceID 1=Heinous.\n\n' +
  'DISTRICTS: CaseMaster has NO district column. It has PoliceStationID, and ' +
  'each station belongs to one district. To COUNT BY district, group by ' +
  'PoliceStationID and pass rollup="district". To FILTER by one district, do ' +
  'not give up — call join_records with base="CaseMaster" and ' +
  'district="<name>", which resolves the stations for you.\n\n' +
  'RELATING TWO TABLES: use join_records. It runs both queries and matches them ' +
  'on CaseMasterID inside the function, so the ids never have to pass through ' +
  'you. Do NOT try to do this by pasting a long IN list into query_records — the ' +
  'list gets truncated and the answer comes out silently wrong.\n\n' +
  'Data covers 2023-01-01 to 2026-06-30.\n\n';

// The platform, described for the model.
//
// Hoisted above TOOL_SYSTEM because both lanes now read it: the guide lane
// knew the whole platform and had no tools, the tool lane had the tools and
// did not know the platform existed, and an officer asking "who does X work
// with, and where can I see the whole network" only ever got whichever half
// the router happened to pick.
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
Report Studio [/report-studio]: draft, edit and file statutory & administrative police reports from prescribed templates — FIR (IIF-1), Case Diary (S.192 BNSS), Arrest/Court Surrender Memo (IIF-3), Charge Sheet / Final Report (IIF-5), UDR/Death Report, Missing Person Report, Property Seizure Memo (IIF-4), Daily Station Report/General Diary, Law & Order Report, Crime Analysis Report, Police Performance Report and Court/Case Status Report. Paged A4 editor with zoom, add-page (continuation/accused/property sheets), autosave to the archive, AI narrative polish, finalize (read-only lock) and PDF download.
Records [/records]: digitised paper records — officers photograph, scan, drag-drop or bulk-upload documents; Zia OCR extracts the text and an AI pass classifies the document, pulls out key fields and reconstructs any tables. Everything is searchable, and questions about scanned paper are answered from this store.
Assistant [/assistant]: this chat — ask about data, law, or the platform.
Personnel Directory [/personnel]: officer directory (rank, unit, district). Sub-pages: Duty Roster [/personnel/roster] (shift schedule), Org Chart [/personnel/org-chart] (command hierarchy).
Access & Audit [/access]: admin only — assign roles and browse/export the audit trail of who did what, where and when.
Global search: press Ctrl/⌘-K anywhere to jump to any of the above.`;

const TOOL_SYSTEM =
  'You are Sentinel Assistant, working for a Karnataka police officer. Answer ' +
  'the question by calling the tools available to you, then say what you found.\n\n' +
  // BUG FIX: this read `TOOL_SCHEMA_NOTE + + 'Call tools...'`. The second plus
  // parsed as a UNARY plus on the following string, which evaluates to NaN, so
  // the concatenation produced the literal text "NaN" and silently dropped the
  // whole parallelism-and-error-recovery paragraph from the system prompt. The
  // loop has been running without those instructions; nothing failed loudly,
  // it just batched less and retried failing calls more.
  TOOL_SCHEMA_NOTE +
  'Call tools in parallel when they do not depend on each other. Look up a ' +
  'reference id rather than guessing it. If a tool returns an error, read it and ' +
  'fix the call rather than repeating it.\n\n' +
  'When the officer asks what is urgent, what needs doing, or whether anything ' +
  'is running out of time, call case_obligations — that is a different question ' +
  'from retrieving records, and query_records cannot answer it. Lead with the ' +
  'nearest deadline and say what happens when it passes.\n\n' +
  'Answer only from what the tools returned. If they returned nothing useful, ' +
  'say so plainly — never fill the gap from general knowledge, and never state a ' +
  'number the records did not give you. Some results note that rows were ' +
  'withheld for clearance; do not speculate about what they contained.\n\n' +

  // ── Drawing ──────────────────────────────────────────────────────────────
  // The tool lane could never draw. extractAgui ran on its output, but nothing
  // in this prompt told the model a component block was possible, so every
  // relational answer — the ones only this lane can reach — came back as prose.
  // "Show me the gang ring of X" called traverse_network, got the ring, and
  // described it in a paragraph. The renderer had been able to draw that graph
  // the whole time.
  'DRAWING RESULTS\n' +
  'After your prose you MAY append ONE fenced ```agui block of JSON ' +
  '{"components":[...]} to draw what you found. Use it whenever the answer has ' +
  'shape a picture carries better than a sentence — a ring of people, a trend ' +
  'over months, a split across districts. Never draw a single number.\n' +
  AGUI_SHAPES +
  'Draw ONLY from figures the tools returned. A chart is a claim about the ' +
  'records exactly as a sentence is, and an invented data point is worse than an ' +
  'invented sentence because it looks measured.\n\n' +

  // ── The rest of the app ──────────────────────────────────────────────────
  // The guide lane knew the whole platform and had no tools; this lane had the
  // tools and did not know the platform existed. An officer asking "who does
  // Jagdish work with, and where can I see the whole network" was answered by
  // whichever lane the router picked, and only ever got half.
  'THE REST OF SENTINEL\n' +
  'You also know the platform itself, mapped below. When the officer would be ' +
  'better served by a screen than by your answer — a map to pan, a network to ' +
  'explore, a form to file — say so in one sentence and name the module and its ' +
  'route, after answering what you can from the records. Do not send them away ' +
  'instead of answering; send them on afterwards. Never name a module or route ' +
  'that is not in this map.\n\n' +
  APP_GUIDE;

/**
 * Runs the tool loop on Claude. Returns null when it cannot run at all — no
 * key, or the model produced nothing — so the caller can fall through to the
 * lanes that were already there.
 */
async function runToolLoop({ query, history, app, role, req, bucket }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const started = Date.now();
  const used = [];       // what ran, for the audit trail
  const rowSets = [];    // Data Store rows, for citations
  const scanHits = [];   // digitised records, for citations
  const toolThreats = []; // injection markers found in retrieved content
  let usedKnowledgeBase = false;

  const deps = {
    app,
    role,
    ragSearch: async (q) => {
      usedKnowledgeBase = true;
      const token = await getAccessToken();
      const r = await fetch(RAG_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CATALYST-ORG': ORG,
          Authorization: `Zoho-oauthtoken ${token}`,
        },
        body: JSON.stringify({ query: q }),
        signal: AbortSignal.timeout(15_000),
      });
      const d = await r.json().catch(() => ({}));
      return r.ok ? (d.response || d.answer || d.result || '') : '';
    },
    digitisedSearch: async (q) => {
      const hits = await searchDigitised(bucket, q, 6);
      scanHits.push(...hits);
      return hits;
    },
    // The same builder the Action Queue page uses, so "what's urgent?" asked in
    // chat and the page an officer opens cannot give different answers.
    // Computed lazily: most questions never touch it, and it reads every open
    // case record.
    caseObligations: async () => {
      // Identity resolved here rather than threaded through runToolLoop's
      // signature: requestUser is memoised per app instance, so this costs
      // nothing on the hot path, and it keeps "whose cases?" answered by the
      // session rather than by anything the model could influence.
      const u = await requestUser(app);
      return buildActionQueue(bucket, {
        email: String(u?.email_id || '').toLowerCase(),
        name: [u?.first_name, u?.last_name].filter(Boolean).join(' '),
      });
    },
  };

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = anthropicClient || (anthropicClient = new (Anthropic.default || Anthropic)());
    const messages = [
      ...history.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: query },
    ];
    // A conversation may not open on an assistant turn.
    while (messages.length && messages[0].role === 'assistant') messages.shift();

    for (let i = 0; i < TOOL_MAX_ITERATIONS; i++) {
      const outOfTime = Date.now() - started > TOOL_BUDGET_MS;
      const res = await client.messages.create(
        {
          model: CLAUDE_MODEL,
          max_tokens: 4096,
          system: TOOL_SYSTEM,
          output_config: { effort: 'low' },
          // On the last permitted turn the tools are withdrawn, which is what
          // forces an answer instead of another call the loop cannot service.
          ...(i === TOOL_MAX_ITERATIONS - 1 || outOfTime
            ? {}
            : { tools: assistantTools.DEFINITIONS }),
          messages,
        },
        { timeout: 30_000 }
      );

      const calls = (res.content || []).filter((b) => b.type === 'tool_use');
      if (!calls.length || res.stop_reason !== 'tool_use') {
        const text = (res.content || [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        if (!text) return null;
        return { text, used, rowSets, scanHits, usedKnowledgeBase, protectedAccess, toolThreats, iterations: i + 1 };
      }

      messages.push({ role: 'assistant', content: res.content });
      // Parallel calls come back in one turn and their results must go back in
      // ONE user message — splitting them teaches the model to stop batching.
      const results = await Promise.all(
        calls.map(async (c) => {
          const out = await assistantTools.run(c.name, c.input, deps);
          used.push(`${c.name}${out && out.error ? ':error' : ''}`);
          if (out && out._protectedAccess) protectedAccess.push(out._protectedAccess);
          // Injection markers found inside retrieved content. Collected for the
          // audit trail and stripped below with the rest of the bookkeeping —
          // the model is given the fenced text, never the fact that we
          // suspected it, which would only invite it to argue the point.
          if (out && out._threat) toolThreats.push(...out._threat);
          if (c.name === 'query_records' && out && Array.isArray(out.rows) && out.rows.length) {
            rowSets.push({ rows: out.rows, query: (c.input && c.input.zcql) || '' });
          }
          // Internal bookkeeping never goes back to the model.
          const { _redactions, _hits, _protectedAccess, _threat, ...clean } = out || {};
          // Every tool result is fenced, not just the two that carry obviously
          // foreign text.
          //
          // search_knowledge_base and search_scanned_records fence their own
          // passages, which left six tools returning record fields straight
          // into the loop — and record fields are not system-generated. A
          // BriefFacts narrative, a person's name, a diary entry: all of them
          // are prose some human typed, and on a live CCTNS the person who
          // decides what an FIR says is partly the person who walks in to file
          // one. Fencing at this single choke point covers all eight tools and
          // any tool added later, which is the property worth having.
          const body = JSON.stringify(clean).slice(0, 12_000);
          return {
            type: 'tool_result',
            tool_use_id: c.id,
            // Already fenced inside the tool — nesting a second wrapper adds
            // tokens and says nothing new.
            content: /<<<UNTRUSTED_[0-9a-f]{16}>>>/.test(body)
              ? body
              : guard.fence(body, `output from the ${c.name} tool, read from police records`),
            ...(out && out.error ? { is_error: true } : {}),
          };
        })
      );
      messages.push({ role: 'user', content: results });
    }
    return null;
  } catch (e) {
    console.warn('tool loop failed (non-fatal):', (e && e.message) || e);
    return null;
  }
}

const VISION_SYSTEM =
  'You are Sentinel Assistant, helping a Karnataka police officer read files they have ' +
  'attached to their question. Each is given to you as extracted TEXT, never as the file ' +
  'itself: a photograph arrives as what an OCR and vision pass could read from it, and a ' +
  'document, spreadsheet, presentation or PDF arrives as the text read straight out of ' +
  'it.\n' +
  'Answer ONLY from those extracts. If the officer asks something they do not cover, say ' +
  'plainly that it is not legible or not present in the file; never guess at what a ' +
  'smudged field might say, and never fill in a missing detail from general knowledge — ' +
  'an invented crime number or section on a police document is far worse than an ' +
  'admission that it could not be read.\n' +
  'A long file may be truncated; if the answer would depend on a part you were not ' +
  'given, say so rather than answering from the part you have.\n' +
  'Where the extract is marked [redacted] or [phone redacted], the data exists but is ' +
  'above the caller\'s clearance: say it is restricted, do not speculate about it.\n' +
  'Be concise and factual. Use markdown, never raw HTML.';

// ── Intent routing ──────────────────────────────────────────────────────────
// Two changes over a bare one-word classifier.
//
// First, a DETERMINISTIC OVERRIDE. A query carrying an unmistakable structural
// signal — an FIR/crime number, an explicit statistics ask — is routed without
// consulting the model at all: cheaper, instant, and not susceptible to a
// classifier having an off day on the most common queries in the product.
//
// Second, CONFIDENCE. The model is asked for a route AND how sure it is, so a
// genuinely ambiguous query can be handled as ambiguous instead of being
// forced into a coin-flip. Two distinct outcomes come out of that:
//   • BOTH  — a mixed-intent query ("what's the procedure for FIR 4029?")
//     needs SOP knowledge and record data. Fan out to RAG and ZCQL in
//     parallel and merge, rather than answering half the question well.
//   • low confidence — genuinely unclear; prefer the broader source over
//     guessing between two narrow ones.
// A mixed-intent query and an unclear one are different cases and are kept
// distinct, per the review.
const CRIME_NO_RE = /\b(?:fir|crime|case)\s*(?:no\.?|number|#)?\s*[:#]?\s*(\d{1,5}\s*\/\s*\d{4})\b/i;
const BARE_CRIME_NO_RE = /\b\d{1,5}\/\d{4}\b/;
const STATS_RE = /\b(how many|count|total|number of|top \d+|statistics|stats|trend|per district|by district|breakdown)\b/i;
const SOP_RE = /\b(procedure|process|how (?:do|should) (?:i|we)|what is the rule|guidelines?|sop|section \d+|under (?:ipc|bns|crpc|bnss))\b/i;

// Returns a route decision without a model call, or null to fall through.
function deterministicRoute(query) {
  const q = String(query || '');
  const hasRecord = CRIME_NO_RE.test(q) || BARE_CRIME_NO_RE.test(q);
  const hasSop = SOP_RE.test(q);

  // Both signals present is the textbook mixed-intent case.
  if (hasRecord && hasSop) {
    return { route: 'BOTH', confidence: 0.95, why: 'record-id + procedure language' };
  }
  if (hasRecord) return { route: 'ZCQL', confidence: 0.9, why: 'record identifier' };
  if (STATS_RE.test(q) && !hasSop) return { route: 'ZCQL', confidence: 0.85, why: 'aggregate language' };
  return null;
}

// Threshold deliberately conservative: below this, prefer the broader source
// over a confident-looking wrong route. Tune from the logged decisions.
const ROUTE_CONFIDENCE_FLOOR = 0.55;

function parseRouteReply(raw) {
  if (!raw) return null;
  const txt = String(raw);
  // Accept {"route":"ZCQL","confidence":0.8} or a bare word, so a model that
  // ignores the JSON instruction still produces a usable decision.
  try {
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      const route = String(o.route || '').toUpperCase();
      if (['CHAT', 'GUIDE', 'ZCQL', 'RAG', 'BOTH', 'TOOLS'].includes(route)) {
        const c = Number(o.confidence);
        return { route, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.6 };
      }
    }
  } catch { /* fall through to word matching */ }
  const word = /\b(BOTH|TOOLS|CHAT|GUIDE|ZCQL|RAG)\b/i.exec(txt);
  // A bare word carries no self-reported confidence; assume just above the
  // floor so it is used, but treated as weaker than a scored answer.
  return word ? { route: word[1].toUpperCase(), confidence: 0.6 } : null;
}

// ── Slash commands ──────────────────────────────────────────────────────────
// A fixed set of shortcuts for the queries officers repeat. Each one becomes a
// precise, pre-written question for the pipeline that already answers it,
// rather than a parallel query stack: the same ZCQL guardrails, the same role
// checks, the same audit trail.
//
// Where Sentinel genuinely has no such data — there is no vehicle registry in
// the Data Store — the command says so plainly instead of returning something
// invented. A fabricated ownership record in a police tool is worse than no
// answer at all.
const SLASH_ROLES = {
  fir: ['admin', 'supervisor', 'investigator'],
  case: ['admin', 'supervisor', 'investigator'],
  suspect: ['admin', 'supervisor', 'investigator'],
  vehicle: ['admin', 'supervisor', 'investigator'],
  person: ['admin', 'supervisor', 'investigator'],
  'crime-stats': ['admin', 'supervisor', 'investigator', 'analyst', 'policymaker'],
  hotspot: ['admin', 'supervisor', 'investigator', 'analyst', 'policymaker'],
  wanted: ['admin', 'supervisor', 'investigator'],
  missing: ['admin', 'supervisor', 'investigator'],
  help: null,
};
// Commands touching person or case records — logged on every execution.
const SLASH_SENSITIVE = new Set(['fir', 'case', 'suspect', 'vehicle', 'person', 'wanted', 'missing']);

const SLASH_HELP = [
  ['/fir [FIR number]', 'Get FIR details and current status'],
  ['/case [case ID]', 'Case summary, IO assigned, current stage'],
  ['/suspect [name or ID]', 'Criminal record / antecedents check'],
  ['/vehicle [registration no]', 'Vehicle ownership & crime linkage check'],
  ['/person [name or phone]', 'Person search across connected records'],
  ['/crime-stats [district/PS] [date range]', 'Crime count summary by type'],
  ['/hotspot [area]', 'Crime hotspot data for a location'],
  ['/wanted [name or area]', 'Search wanted/absconding offenders list'],
  ['/missing [name or ID]', 'Missing person case lookup'],
  ['/help', 'List all available commands'],
  ['/clear', 'Clear current chat context'],
];

function parseSlash(text) {
  const s = String(text || '').trim();
  if (!s.startsWith('/')) return null;
  const sp = s.indexOf(' ');
  const name = (sp === -1 ? s.slice(1) : s.slice(1, sp)).toLowerCase();
  const arg = sp === -1 ? '' : s.slice(sp + 1).trim();
  if (!name || !(name in SLASH_ROLES)) return null;
  return { name, arg };
}

// Turn a command into the question the existing pipeline answers best. The
// wording matters: it is what the router and the ZCQL generator see.
function slashToQuery(name, arg) {
  switch (name) {
    case 'fir':
      return `Show the FIR with crime number ${arg} — registration date, police station, district, sections of law, case status and brief facts.`;
    case 'case':
      return `Show case ${arg} — case number, investigating officer, police station, district, current case status and registration date.`;
    case 'suspect':
      return `List every case in which the accused person ${arg} is named, with crime number, date, police station and case status.`;
    case 'person':
      return `Find every record naming the person ${arg} — as accused, complainant or victim — with the crime number and date of each case.`;
    case 'crime-stats':
      return arg
        ? `Give a crime count summary by crime type for ${arg}.`
        : 'Give a crime count summary by crime major head across all districts.';
    case 'hotspot':
      return arg
        ? `Which police stations and areas in ${arg} have the highest number of registered crimes? List the top ones by count.`
        : 'Which districts have the highest number of registered crimes? List the top districts by count.';
    case 'wanted':
      return arg
        ? `List accused persons connected to ${arg} who have no arrest or surrender record, with their crime numbers and case status.`
        : 'List accused persons who have no arrest or surrender record, with their crime numbers and case status.';
    default:
      return arg || name;
  }
}

// ── Multilingual support (English / Hindi / Kannada) ────────────────────────
// Officers ask in the language they work in; retrieval and the Data Store are
// English. So a request carries the language the UI is in (`preferred_lang`),
// the query is identified and normalised to English for retrieval, and the
// answer is generated back in the officer's language.
const SUPPORTED_LANGS = ['en', 'hi', 'kn'];
// Used to verify an answer really came back in the language it was meant to.
// Presence of the script is decisive; absence of it in text that has words is
// the translation having quietly failed.
const SCRIPT = { hi: /[\u0900-\u097F]/, kn: /[\u0C80-\u0CFF]/ };
const LANG_NAME = { en: 'English', hi: 'Hindi', kn: 'Kannada' };

// Language identification.
//
// Devanagari and Kannada occupy distinct Unicode blocks, so their PRESENCE is
// decisive — no probabilistic model needed. The reverse is not true: Latin
// script is NOT evidence of English, because Hinglish and Kanglish ("FIR ka
// detail dijiye") are typed in Latin, and an identifier-only query
// ("KA01AB1234") carries no linguistic signal at all. For Latin text the
// officer's selected language decides, which is the setting they chose
// deliberately.
function detectLang(text, preferred) {
  const s = String(text || '');
  const deva = (s.match(/[\u0900-\u097F]/g) || []).length;
  const knda = (s.match(/[\u0C80-\u0CFF]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  const indic = deva + knda;
  const total = indic + latin;
  const pref = SUPPORTED_LANGS.includes(preferred) ? preferred : 'en';

  if (!total) return { lang: pref, confidence: 0, indic: false };

  if (indic > 0) {
    const lang = deva >= knda ? 'hi' : 'kn';
    const confidence = Math.max(deva, knda) / total;
    // A third of the letters in an Indic script is plenty — these queries are
    // routinely peppered with Latin identifiers and section numbers.
    if (confidence >= 0.35) return { lang, confidence, indic: true };
    return { lang: pref, confidence, indic: true, mixed: true };
  }

  // Pure Latin: English if that is what they selected, otherwise transliterated
  // Hindi/Kannada, which the normaliser handles.
  return { lang: pref, confidence: 1, indic: false, mixed: pref !== 'en' };
}

// Translate a non-English question into English for retrieval, keeping the
// identifiers that must survive verbatim (crime numbers, sections, plates).
async function normaliseToEnglish(query, lang) {
  if (lang === 'en') return query;
  const out = await callLLM(
    [
      {
        role: 'system',
        content:
          'Translate this police query into English for a database and document search. ' +
          'Keep every identifier EXACTLY as written — crime and FIR numbers, IPC/BNS section ' +
          'numbers, vehicle registration numbers, dates, proper names. Translate the rest, ' +
          'using standard Indian police vocabulary (चोरी → theft, ಕಳವು → theft, ' +
          'दुर्घटना → accident, ಅಪಘಾತ → accident). Output ONLY the English query.',
      },
      { role: 'user', content: query },
    ],
    { maxTokens: 220, temperature: 0, timeoutMs: 10_000, model: GROQ_MODEL_FAST }
  );
  return (out && out.trim()) || query;
}

// Re-express an English answer in the officer's language. Used at the end of
// every path, so the language of the reply never depends on which pipeline
// produced it.
async function localiseAnswer(text, lang) {
  if (lang === 'en' || !text || !text.trim()) return text;
  const out = await callLLM(
    [
      {
        role: 'system',
        content:
          `Rewrite the following police assistant answer in ${LANG_NAME[lang]}. Preserve every ` +
          'number, name, date, crime/FIR number, vehicle registration and section of law exactly ' +
          'as written — transliterate nothing that identifies a record. Keep any markdown ' +
          'structure (headings, lists, tables) intact. Legal precision matters more than ' +
          'elegance: if a term has no accepted translation, keep the English term and gloss it ' +
          'in brackets. Output ONLY the rewritten answer.',
      },
      { role: 'user', content: text },
    ],
    { maxTokens: 1400, temperature: 0.2, timeoutMs: 20_000 }
  );
  return (out && out.trim()) || text;
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
  'You are Sentinel Assistant, helping Indian police analysts. Answer from general ' +
  'knowledge — Indian law, police procedure, criminology, general facts. Be concise ' +
  'and factual. Never say you cannot display charts or images and never describe what ' +
  'a chart would look like — just present the data plainly. ' +
  'IMPORTANT: never begin your reply with a disclaimer or a negative statement such as ' +
  '"I don\'t have data", "I don\'t have real-time access", "I cannot find", or a caveat ' +
  'about privacy/restrictions — lead directly with the substantive answer and the ' +
  'information you do have. Do not preface the answer with what you lack.';

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

// The FIR knowledge-base document (recent FIR case records, sorted newest-first).
// "recent/latest FIRs in <place>" questions are routed to RAG and answered from
// this document, so we scope retrieval to it to guarantee the FIR records are
// the context (an unscoped search over all docs was missing them and falling
// back to a generic "I don't have real-time access" reply).
const FIR_DOC_ID = process.env.FIR_DOC_ID || '3608000000010039';
const isRecentFirQuery = (q) =>
  /\b(recent|latest|newest|new|last|current)\b/i.test(q) &&
  /\bfirs?\b|\bcases?\b|\bcrimes?\b/i.test(q);

// Worth a second model call only when the prose plausibly contains data to
// visualize: some length plus digits or a multi-item list.
function looksDataShaped(text) {
  const t = String(text);
  const listLines = t.split('\n').filter((l) => /^\s*(\d+[.)]|[-*•])\s+/.test(l)).length;
  return t.length >= 120 && (/\d/.test(t) || listLines >= 3);
}

// What the renderer can draw. A model can only propose what this list allows,
// so the list is the assistant's visual vocabulary — it was six types for a
// long time, and that quietly shaped the answers: asked for a trend it drew a
// bar chart, asked for a composition it drew a table.
const AGUI_TYPES = new Set([
  'bar-chart', 'pie-chart', 'line-chart', 'multi-line-chart', 'stacked-bar-chart',
  'heat-grid', 'scatter-plot', 'funnel', 'pyramid', 'sankey',
  'table', 'cards', 'geo-map', 'network-graph',
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

  const lang = String(language || 'en').slice(0, 2).toLowerCase();

  const token = await getAccessToken();
  const form = new FormData();
  form.append(
    ZIA_FILE_FIELD,
    new Blob([buf], { type: mimetype || 'audio/wav' }),
    filename || 'recording.wav'
  );
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
// POST /server/rag/report-pdf  { html, kind?, title? }  →  200 { pdf: <base64> }
//
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
  const t = await callLLM(
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

// ── Custody & Corrections registry (Catalyst Data Store) ────────────────────
// One row per person keyed by PersonId; the full custodial record is stored as
// a JSON `Details` blob (Name/Status/Facility denormalised for querying). The
// client seeds the table from its computed registry, then reads/edits this as
// the authoritative source. Falls back gracefully (persisted:false) if the
// table isn't created yet, so the feature keeps working on synthesis alone.
//
// Table `CustodyRecords`: PersonId Varchar · Name Varchar · Status Varchar ·
// Facility Varchar · Details Text · UpdatedAt BigInt · UpdatedBy Varchar
const CUSTODY_TABLE = process.env.CUSTODY_TABLE || 'CustodyRecords';
const czq = (s) => String(s).replace(/'/g, "''");
const cUnwrap = (r) => (r && r[CUSTODY_TABLE] ? r[CUSTODY_TABLE] : r || {});

async function custodyExistingIds(app) {
  const ids = new Set();
  for (let off = 0; off < 40000; off += 300) {
    const rows = await app.zcql().executeZCQLQuery(`SELECT PersonId FROM ${CUSTODY_TABLE} LIMIT ${off},300`);
    if (!rows || !rows.length) break;
    rows.forEach((r) => ids.add(String(cUnwrap(r).PersonId)));
    if (rows.length < 300) break;
  }
  return ids;
}

async function handleCustody(req, res, action) {
  const app = catalystSDK.initialize(req);
  try {
    if (action === 'list') {
      const out = [];
      for (let off = 0; off < 40000; off += 300) {
        const rows = await app.zcql().executeZCQLQuery(`SELECT ROWID, PersonId, Details FROM ${CUSTODY_TABLE} LIMIT ${off},300`);
        if (!rows || !rows.length) break;
        rows.forEach((r) => { try { const p = JSON.parse(cUnwrap(r).Details || 'null'); if (p) out.push(p); } catch { /* skip */ } });
        if (rows.length < 300) break;
      }
      return json(res, 200, { records: out, persisted: true });
    }

    const body = JSON.parse((await readBody(req)) || '{}');

    if (action === 'save') {
      const rec = body.record;
      if (!rec || !rec.personId) return json(res, 400, { error: 'record.personId required' });
      const caller = await requestUser(app);
      const table = app.datastore().table(CUSTODY_TABLE);
      const base = {
        Name: String(rec.name || '').slice(0, 200),
        Status: String(rec.status || '').slice(0, 40),
        Facility: String(rec.facility || '').slice(0, 200),
        Details: JSON.stringify(rec).slice(0, 200000),
        UpdatedAt: Date.now(),
        UpdatedBy: String(caller?.email_id || '').slice(0, 200),
      };
      const found = await app.zcql().executeZCQLQuery(`SELECT ROWID FROM ${CUSTODY_TABLE} WHERE PersonId = '${czq(rec.personId)}' LIMIT 1`);
      if (found && found.length) {
        await table.updateRow({ ROWID: cUnwrap(found[0]).ROWID, ...base });
      } else {
        await table.insertRow({ PersonId: String(rec.personId).slice(0, 64), ...base });
      }
      return json(res, 200, { ok: true });
    }

    if (action === 'seed') {
      const records = Array.isArray(body.records) ? body.records : [];
      if (!records.length) return json(res, 200, { seeded: 0 });
      const existing = await custodyExistingIds(app);
      const now = Date.now();
      const rows = records
        .filter((r) => r && r.personId && !existing.has(String(r.personId)))
        .slice(0, 200)
        .map((r) => ({
          PersonId: String(r.personId).slice(0, 64),
          Name: String(r.name || '').slice(0, 200),
          Status: String(r.status || '').slice(0, 40),
          Facility: String(r.facility || '').slice(0, 200),
          Details: JSON.stringify(r).slice(0, 200000),
          UpdatedAt: now,
          UpdatedBy: 'seed',
        }));
      if (!rows.length) return json(res, 200, { seeded: 0, skipped: records.length });
      await app.datastore().table(CUSTODY_TABLE).insertRows(rows);
      return json(res, 200, { seeded: rows.length });
    }

    return json(res, 404, { error: 'unknown action' });
  } catch (e) {
    // Table not created yet (or a Data Store error) — signal not-persisted so
    // the client keeps using its computed registry.
    return json(res, 200, { records: [], persisted: false, error: (e && e.message) || String(e) });
  }
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
  const app = catalystSDK.initialize(req);
  // The signed-in officer, NOT body.email. The client still sends its own
  // address and this deliberately ignores it: a chat history is personal, and
  // an address in a request body is chosen by whoever is making the request.
  const caller = await requestUser(app);
  const email = String((caller && caller.email_id) || '').trim().toLowerCase();
  if (!email) return json(res, 401, { error: 'Sign in to use the assistant.' });

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
  // Session identity, not the ?email= the caller passed — a profile photo is
  // written under whoever is signed in.
  const photoApp = catalystSDK.initialize(req);
  const photoUser = await requestUser(photoApp);
  const email = String((photoUser && photoUser.email_id) || '').trim().toLowerCase();
  if (!email) return json(res, 401, { error: 'Sign in to update your photo.' });
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
  const app = catalystSDK.initialize(req);
  // Own profile only. body.email is ignored: it used to select whose profile
  // was read and written, which let any caller fetch or overwrite a
  // colleague's record by naming their address.
  const caller = await requestUser(app);
  const email = String((caller && caller.email_id) || '').trim().toLowerCase();
  if (!email) return json(res, 401, { error: 'Sign in to view your profile.' });
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
const LAST_ACTIVE_KEY = 'access/last-active.json';
const APP_ROLES = ['investigator', 'analyst', 'supervisor', 'policymaker', 'admin'];

// ── Stratus key confinement ────────────────────────────────────────────────
//
// Several routes take an object key from the request body — the client is
// handing back a key this function gave it earlier (an uploaded scan, a
// recording). Those routes checked `key.startsWith(PREFIX)` and stopped there,
// which confines the key only if the store treats keys as opaque strings.
//
// That is an assumption about someone else's storage layer, and it is the
// wrong thing to bet a police evidence store on. If Stratus ever normalises
// `..` the way a filesystem does, then
//
//     investigation/media/../../access/roles.json
//
// passes startsWith and walks straight out of the prefix into the role map.
// The check costs a regex, so there is no reason to depend on the answer:
// reject traversal, absolute paths, backslashes, NUL and control characters
// outright, and require the key to sit under the prefix.
//
// Returns the key when it is safe, or null when it is not — callers 400.
function confineKey(key, prefix) {
  const k = String(key == null ? '' : key);
  if (!k || k.length > 512) return null;
  if (!k.startsWith(prefix)) return null;
  if (k.includes('..') || k.includes('\\') || k.startsWith('/')) return null;
  // Control characters (NUL included) have no place in a key we generated.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(k)) return null;
  return k;
}

async function loadRolesBlob(bucket) {
  try {
    const parsed = JSON.parse((await streamToString(await bucket.getObject(ROLES_KEY))) || '{}');
    return parsed && parsed.users && typeof parsed.users === 'object' ? parsed : { users: {} };
  } catch {
    return { users: {} };
  }
}

// email → { ts, istTime } of the most recent activity. One small blob, updated
// (throttled) on each audit write, read by the Access Control table.
async function loadLastActive(bucket) {
  try {
    const parsed = JSON.parse((await streamToString(await bucket.getObject(LAST_ACTIVE_KEY))) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// The caller's identity comes from the Catalyst session cookie forwarded with
// every /server/ call — never from the request body — so admin-only endpoints
// can't be reached by editing a JSON payload.
// Memoised per Catalyst app instance — one instance is created per request, so
// this is request-scoped. The session lookup is a network call, and the gate
// below plus myRole() plus the audit writer all want the same answer.
const userCache = new WeakMap();
async function requestUser(app) {
  if (userCache.has(app)) return userCache.get(app);
  let u = null;
  try {
    u = await app.userManagement().getCurrentUser();
  } catch {
    u = null;
  }
  userCache.set(app, u);
  return u;
}

// ── API gate ───────────────────────────────────────────────────────────────
//
// Every route on this function serves the signed-in officer's console. There
// is no anonymous surface here — no public read API, no webhook, no payment
// callback — so authentication belongs to the router rather than to each
// handler's good intentions. Leaving it per-handler is what produced the two
// problems this replaces:
//
//   1. Several endpoints had no check at all. /transcribe and /report-pdf call
//      metered Zoho APIs, and the assistant route itself calls an LLM, so an
//      unauthenticated caller could spend the project's quota at will.
//   2. Worse, /conversations/* and /profile/* took the officer's identity from
//      a field in the request body. Anyone who knew a colleague's address
//      could read, overwrite or delete that officer's entire assistant
//      history. Identity must come from the session, never from the payload.
//
// The session is Catalyst's own (Zoho OAuth, same cookie the app signs in
// with); there is no second token to mint or rotate.
async function requireSession(req, res) {
  const app = catalystSDK.initialize(req);
  const user = await requestUser(app);
  const email = String((user && user.email_id) || '').trim().toLowerCase();
  if (!email) {
    json(res, 401, { error: 'Sign in to use Sentinel.' });
    return null;
  }
  return { app, user, email };
}

// ── Cross-site request forgery ─────────────────────────────────────────────
//
// Every route here is a POST authenticated by the Catalyst session cookie, and
// the cookie is attached by the browser on any request it decides to send.
// Nothing in this function previously distinguished a POST the officer's own
// console made from one that a page on another site made on their behalf. A
// hostile page an officer visits while signed in could therefore have driven
// /investigation/delete or /access/save with their clearance.
//
// What was actually stopping that: the SameSite attribute on Zoho's session
// cookie, plus CORS preflight. Both are real, and neither is ours. SameSite
// defaults to Lax in current browsers, but it is set by the identity provider,
// not by this code, and preflight is dodged entirely by sending the JSON as
// Content-Type: text/plain — a "simple" request that needs no preflight, and
// which readBody/JSON.parse below accept happily because neither looks at the
// content type. So the protection was a third party's default, one header
// away from gone.
//
// The check: if the request carries an Origin, it must be one of ours. A
// browser sends Origin on every cross-origin request and on same-origin POSTs,
// so a forged request from another site always brings one and is refused.
//
// A request with NO Origin is allowed through to the session gate. That is
// deliberate, not an oversight: curl, CI and server-to-server callers omit it,
// and none of them is the threat here — a CSRF attack runs in a browser, and a
// browser cannot suppress the header. Authentication is still required either
// way; this only removes the cross-site path to it.
//
// ALLOWED_ORIGINS overrides the default list (comma-separated, scheme + host).
const APP_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((v) => v.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function originAllowed(origin) {
  if (!origin) return true; // no Origin: not a browser-driven cross-site call
  const o = String(origin).trim().replace(/\/+$/, '').toLowerCase();
  if (o === 'null') return false; // sandboxed iframe / opaque origin
  if (APP_ORIGINS.length) return APP_ORIGINS.some((a) => a.toLowerCase() === o);
  let host;
  try {
    const u = new URL(o);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return false;
    host = u.hostname;
  } catch {
    return false;
  }
  // The console is served from the project's own Catalyst domain; local
  // development serves it from localhost. Matched on the parsed hostname, so
  // "evil-catalystserverless.in.attacker.com" cannot pass on a substring.
  return (
    host === 'localhost'
    || host === '127.0.0.1'
    || host.endsWith('.catalystserverless.in')
    || host.endsWith('.catalystserverless.com')
    || host.endsWith('.zohostratus.in')
    || host.endsWith('.zohostratus.com')
  );
}

// ── IP blocklist ───────────────────────────────────────────────────────────
//
// A denylist, deliberately not an allowlist. Officers reach this from stations
// across Karnataka and from mobile networks, so an allowlist would lock out
// legitimate users while stopping nobody who already holds a session. The
// denylist is the half that earns its place: an abusive or compromised source
// can be cut off immediately by editing one environment variable, with no
// redeploy and no code change.
//
// BLOCKED_IPS is a comma-separated list of exact addresses and/or prefixes:
//   BLOCKED_IPS=203.0.113.7,198.51.100.,2001:db8:
// A trailing dot or colon makes an entry a prefix, which is how a whole /24 or
// an address block is expressed without pulling in CIDR arithmetic.
const blockedIps = () =>
  (process.env.BLOCKED_IPS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

function ipBlocked(ip) {
  if (!ip) return false;
  const addr = String(ip).toLowerCase();
  return blockedIps().some((rule) => {
    const r = rule.toLowerCase();
    return r.endsWith('.') || r.endsWith(':') ? addr.startsWith(r) : addr === r;
  });
}

// ── Rate limiting ──────────────────────────────────────────────────────────
//
// A token bucket per officer per minute. Deliberately modest in what it
// claims: a serverless function is many short-lived containers, so this bounds
// what any ONE container will spend rather than enforcing a global ceiling.
// It is a cost and abuse brake on the metered routes — transcription, vision,
// PDF rendering, the LLM lanes — not a security boundary. The Catalyst API
// Gateway's own limiter is the enforcement point that sees every request.
const RATE_GENERAL = Number(process.env.RATE_LIMIT_PER_MIN) || 120;
const RATE_METERED = Number(process.env.RATE_LIMIT_METERED_PER_MIN) || 20;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();

function rateLimited(key, max) {
  const now = Date.now();
  // Bounded: a container that has seen many officers must not hold every
  // bucket for the life of the process.
  if (rateBuckets.size > 5000) {
    for (const [k, b] of rateBuckets) if (now - b.start > RATE_WINDOW_MS) rateBuckets.delete(k);
  }
  const b = rateBuckets.get(key);
  if (!b || now - b.start > RATE_WINDOW_MS) {
    rateBuckets.set(key, { start: now, n: 1 });
    return 0;
  }
  b.n += 1;
  if (b.n > max) return Math.ceil((RATE_WINDOW_MS - (now - b.start)) / 1000);
  return 0;
}

// Routes that cost money per call: Zoho transcription and OCR, SmartBrowz PDF
// rendering, and every lane that reaches an LLM.
const METERED_ROUTES = /\/(transcribe|report-pdf|vision\/parse|reportdocs\/ai|investigation\/summarize|investigation\/ocr|predict\/[a-z]+|forecast(\/refresh)?|digitise\/(upload|ingest))$/;
const isAdminUser = (u) => /admin/i.test(u?.role_details?.role_name || '');

/* ── Case prediction (QuickML) ───────────────────────────────────────────────
   POST /server/rag/predict/chargesheet  { cases: [ {…features}, … ] }

   Serves the trained QuickML models. Three things shape this handler, and none
   of them is optional.

   COST. QuickML inference is billed per call: 500/month free, then $0.0025.
   A dashboard that predicted per row on every render would spend the monthly
   allowance in a single sitting, so callers send a BATCH and the answers are
   cached by feature-hash. A repeat view of the same case costs nothing.

   TRUST. The model is ~82% accurate, which means roughly one in five of these
   is wrong. Every response carries the model version and the likelihood, and
   the UI is expected to show them — a bare "unlikely to be charged" with no
   confidence and no provenance is exactly the kind of output an officer
   cannot argue with and should not have to.

   FEATURES. The 21 keys must match the training columns EXACTLY, including
   case and order-insensitivity of absent keys: QuickML returns null rather
   than an error when a name does not match, which fails silently. FEATURES
   below is the contract, and it is checked rather than assumed.
   ───────────────────────────────────────────────────────────────────────── */
const QUICKML_PREDICT_URL =
  process.env.QUICKML_PREDICT_URL ||
  'https://api.catalyst.zoho.in/quickml/v1/project/49826000000024269/endpoints/predict';

/* Every QuickML model this app serves, in one place.

   `features` is the CONTRACT with the training table. QuickML answers null
   rather than erroring when a feature name does not match, so a typo here
   fails silently and looks like a bad model. The lists below are the exact
   columns ksp/ml/export_training_data.py and export_forecast_data.py write.

   `key` names an env var rather than holding the secret, and each model has
   its own endpoint key — a leaked key is then one model, not all of them. */
const QUICKML_MODELS = {
  chargesheet: {
    keyEnv: 'QUICKML_KEY_CHARGESHEET',
    kind: 'classification',
    features: ['crime_major_head', 'crime_minor_head', 'case_category', 'gravity',
      'police_station', 'district', 'incident_hour', 'incident_weekday',
      'reg_month', 'reg_year', 'report_delay_days', 'n_accused', 'n_victims',
      'n_complainants', 'n_arrests', 'arrest_made', 'accused_age_mean',
      'victim_age_mean', 'station_caseload', 'io_caseload', 'case_age_days'],
    // Reported so the UI can say what a prediction is worth. Roughly one in
    // five is wrong, and a screen that hides that is worse than no model.
    quality: { accuracy: 0.8187, baseline: 0.726 },
  },
  // The two crime-volume FORECAST models used to live here, keyed on a bare
  // period_date. They no longer do. Forecasting moved to forecast.js, which
  // serves all 10 crime heads and all 31 districts from two direct
  // multi-horizon regression pipelines instead of one series per pipeline.
  // Their endpoint keys were reissued with it, so leaving the old entries
  // would have pointed a live route at a contract the models no longer speak.
};

/* A forecast date must land on a period the model was trained on. The weekly
   models are bucketed to ISO-week Mondays, so a Wednesday would either be
   rejected or silently interpolated depending on the engine's mood. */
function snapPeriod(dateStr, grain) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(d.getTime())) return null;
  if (grain === 'week') {
    const dow = (d.getUTCDay() + 6) % 7;       // 0 = Monday
    d.setUTCDate(d.getUTCDate() - dow);
  }
  return d.toISOString().slice(0, 10);
}

const predictCache = new Map(); // model|features -> { at, value }
const PREDICT_TTL_MS = 6 * 60 * 60 * 1000;

async function quickmlPredict(model, features, explain) {
  const key = process.env[model.keyEnv];
  if (!key) throw new Error(`${model.keyEnv} is not configured`);
  const token = await getAccessToken();
  const r = await fetch(`${QUICKML_PREDICT_URL}${explain ? '?explainModel=true' : ''}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-QUICKML-ENDPOINT-KEY': key,
      Authorization: `Zoho-oauthtoken ${token}`,
      'CATALYST-ORG': ORG,
      Environment: process.env.QUICKML_ENV || 'Development',
    },
    body: JSON.stringify({ data: features }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`quickml ${r.status}: ${JSON.stringify(body).slice(0, 240)}`);
  return body;
}

/* POST /server/rag/predict/<model>   { rows: [ {...}, ... ], explain?: bool }

   COST is why this takes a batch and caches. QuickML inference bills per
   call — 500/month free, then $0.0025 — so a screen that predicted per row on
   every render would spend the month's allowance in one sitting. Answers are
   cached by model + feature values; a repeat view costs nothing. */
async function handlePredict(req, res, modelName) {
  const model = QUICKML_MODELS[modelName];
  if (!model) return json(res, 404, { error: `unknown model: ${modelName}` });

  const body = JSON.parse((await readBody(req)) || '{}');
  const rows = Array.isArray(body.rows) ? body.rows : (Array.isArray(body.cases) ? body.cases : []);
  if (!rows.length) return json(res, 400, { error: 'rows[] is required' });
  if (rows.length > 50) return json(res, 400, { error: 'at most 50 rows per call' });
  const explain = body.explain === true;

  const now = Date.now();
  const out = [];
  let billed = 0;
  for (const row of rows) {
    const missing = model.features.filter((k) => row[k] === undefined || row[k] === null);
    if (missing.length) {
      out.push({ id: row.id ?? null, error: `missing: ${missing.join(', ')}` });
      continue;
    }
    const feats = {};
    for (const k of model.features) feats[k] = row[k];
    if (model.kind === 'forecast') {
      const snapped = snapPeriod(feats.period_date, model.grain);
      if (!snapped) {
        out.push({ id: row.id ?? null, error: 'period_date must be YYYY-MM-DD' });
        continue;
      }
      feats.period_date = snapped;
    }
    const ck = `${modelName}|${model.features.map((k) => feats[k]).join('|')}`;

    const hit = predictCache.get(ck);
    if (hit && now - hit.at < PREDICT_TTL_MS && !explain) {
      out.push({ ...hit.value, id: row.id ?? null, cached: true });
      continue;
    }
    try {
      const r = await quickmlPredict(model, feats, explain);
      const raw = Array.isArray(r.result) ? r.result[0] : null;
      const value = model.kind === 'forecast'
        ? { predicted: raw === null ? null : Number(raw), period: feats.period_date }
        : { predicted: raw === null ? null : Number(raw), explanation: explain ? (r.explanation ?? null) : undefined };
      billed += 1;
      if (body.debugRaw === true) value.raw = r;
      if (!explain && body.debugRaw !== true) predictCache.set(ck, { at: now, value });
      out.push({ ...value, id: row.id ?? null, cached: false });
    } catch (e) {
      out.push({ id: row.id ?? null, error: String(e.message).slice(0, 200) });
    }
  }
  return json(res, 200, { model: modelName, kind: model.kind, quality: model.quality,
    predictions: out, billedCalls: billed });
}

/* POST /server/rag/forecast            { refresh?: true }
   POST /server/rag/forecast/refresh

   The Forecasts page in one call: force-wide volume, all 10 crime heads, all
   31 districts, each with its history and its measured accuracy.

   WHY IT IS CACHED IN STRATUS. A full build is 533 QuickML calls (41 series x
   13 weeks), billed per call. Rendering that per page view would spend the
   monthly allowance in a sitting, and an in-memory cache dies with the
   container. The bundle is keyed by the origin week, so a cached copy is not
   stale — the dataset ends where it ends, and the forecast from that origin
   does not move until the data does.

   A refresh re-runs every model call, so it is admin-only. */
async function handleForecast(req, res, forceRefresh) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const key = forecasting.CACHE_KEY();
  const refresh = forceRefresh || body.refresh === true;

  if (refresh) {
    const caller = await requestUser(app);
    if (!isAdminUser(caller)) return json(res, 403, { error: 'admin only' });
  } else {
    try {
      const cached = JSON.parse((await streamToString(await bucket.getObject(key))) || 'null');
      if (cached && cached.origin_week) {
        return json(res, 200, { ...cached, cached: true, billedCalls: 0 });
      }
    } catch { /* no cache yet — fall through and build one */ }
  }

  let bundle;
  try {
    bundle = await forecasting.buildBundle(await getAccessToken());
  } catch (e) {
    return json(res, 503, {
      error: `Forecast models unavailable: ${String(e.message).slice(0, 200)}`,
    });
  }

  // A bundle where every call failed is a broken endpoint, not a forecast.
  // Caching it would pin the failure until someone thought to refresh.
  const anyValue = bundle.total.forecast.some((p) => p.value !== null);
  if (anyValue) {
    try {
      await bucket.putObject(key, Buffer.from(JSON.stringify(bundle), 'utf8'));
    } catch (e) {
      console.error('forecast cache write failed (non-fatal):', e && e.message);
    }
  }
  return json(res, anyValue ? 200 : 503, { ...bundle, cached: false });
}

async function handleAccess(req, res, action) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);

  if (action === 'me') {
    // Your own role, from the session. Reading it by address let anyone
    // enumerate who holds which clearance.
    const me = await requestUser(app);
    const email = String((me && me.email_id) || '').trim().toLowerCase();
    if (!email) return json(res, 401, { error: 'Sign in to continue.' });
    const roles = await loadRolesBlob(bucket);
    const rec = roles.users[email] || {};
    return json(res, 200, {
      role: APP_ROLES.includes(rec.role) ? rec.role : 'investigator',
    });
  }

  const caller = await requestUser(app);
  if (!isAdminUser(caller)) return json(res, 403, { error: 'admin only' });

  if (action === 'users') {
    const [all, roles, lastActive] = await Promise.all([
      app.userManagement().getAllUsers(),
      loadRolesBlob(bucket),
      loadLastActive(bucket),
    ]);
    const users = (all || []).map((u) => {
      const email = String(u.email_id || '').toLowerCase();
      const rec = roles.users[email] || {};
      const la = lastActive[email] || {};
      return {
        email,
        name: [u.first_name, u.last_name].filter(Boolean).join(' '),
        status: u.status || '',
        catalystRole: u.role_details?.role_name || '',
        role: APP_ROLES.includes(rec.role) ? rec.role : isAdminUser(u) ? 'admin' : 'investigator',
        lastActive: la.istTime || '',
        lastActiveTs: la.ts || 0,
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
      // The complete attribution array, stored beside the one-line detail.
      // An answer's sources are part of the immutable record, not a display
      // nicety: a reviewer has to be able to see what the officer was shown
      // as the basis for it, months later, without the conversation.
      ...(Array.isArray(e.sources) && e.sources.length ? { sources: e.sources.slice(0, 30) } : {}),
    };
  });
  const day = new Date(now).toISOString().slice(0, 10);
  const key = `${AUDIT_PREFIX}${day}/${now}-${Math.random().toString(36).slice(2, 8)}.json`;
  // The fingerprint is computed over exactly what is written, by the writer,
  // needing no lock and no read of anything else — see integrity.js for why
  // this log gets per-object hashes plus day seals rather than a row chain.
  await bucket.putObject(
    key,
    Buffer.from(JSON.stringify({ events: enriched, integrity: integrity.sealBlob(enriched) }))
  );

  // Refresh this user's last-active stamp (throttled to ~30s to limit writes).
  if (email) {
    try {
      const la = await loadLastActive(bucket);
      if (!la[email] || now - (la[email].ts || 0) > 30_000) {
        la[email] = { ts: now, istTime: IST_FMT.format(new Date(now)) };
        await bucket.putObject(LAST_ACTIVE_KEY, Buffer.from(JSON.stringify(la)));
      }
    } catch (e) {
      console.error('last-active update failed (non-fatal):', e && e.message);
    }
  }
}

// ── Audit integrity: day seals ─────────────────────────────────────────────
// A seal is written once per day, after that day is over and its set of audit
// objects is therefore closed. Sealing is the only part of tamper-evidence
// that coordinates, and it happens at most once per day rather than on every
// write — see integrity.js for the reasoning.
const SEAL_PREFIX = 'audit/seals/';
const SEAL_HEAD_KEY = 'audit/seals/_head.json';
const sealKey = (day) => `${SEAL_PREFIX}${day}.json`;
// Audit keys are bucketed by UTC date (see writeAuditEvents), so "is this day
// finished" has to be asked in the same calendar the keys were written in.
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

async function loadJsonObject(bucket, key) {
  try {
    const raw = await streamToString(await bucket.getObject(key));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Every audit object for one day, with its key — the key is what a seal names. */
async function loadAuditDay(bucket, day, cap = 5000) {
  const files = [];
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
    const blobs = await Promise.all(keys.map((k) => loadJsonObject(bucket, k)));
    keys.forEach((k, i) => files.push({ key: k, blob: blobs[i] || {} }));
    token =
      page?.truncated === 'true' || page?.truncated === true
        ? page?.next_continuation_token
        : undefined;
  } while (token && files.length < cap);
  return files;
}

/**
 * Seal one finished day, if it is not sealed already.
 *
 * Returns the seal (existing or new), or null when the day holds nothing worth
 * sealing. Two admins opening the page at the same moment could both write a
 * seal for the same day; the loser is overwritten and its seq is orphaned,
 * which verify() reports as a gap rather than as tampering. Stratus offers no
 * compare-and-swap to do better, and a rare duplicate is a far smaller problem
 * than sealing on the write path would be.
 */
async function sealDayIfClosed(bucket, day, files, opts) {
  if (day >= utcDay()) return null;                      // still open, contents can change
  // `known` lets a caller that has already read the seal skip a second fetch;
  // undefined means "not looked yet", null means "looked, none there".
  const existing = opts && 'known' in opts ? opts.known : await loadJsonObject(bucket, sealKey(day));
  if (existing) return existing;
  // Nothing hashed means nothing a seal could attest to. Sealing a day of
  // pre-integrity objects would record their absence of proof as if it were
  // proof.
  const hashable = files.filter((f) => f.blob && f.blob.integrity && f.blob.integrity.events);
  if (!hashable.length) return null;

  const head = (await loadJsonObject(bucket, SEAL_HEAD_KEY)) || {};
  const seal = integrity.buildSeal({
    day,
    blobs: hashable.map((f) => ({
      key: f.key,
      hash: f.blob.integrity.events,
      count: (f.blob.events || []).length,
    })),
    prevSealHash: head.sealHash || integrity.GENESIS,
    prevDay: head.day || null,
    seq: Number(head.seq || 0) + 1,
    sealedAt: new Date().toISOString(),
  });
  await bucket.putObject(sealKey(day), Buffer.from(JSON.stringify(seal)));
  await bucket.putObject(
    SEAL_HEAD_KEY,
    Buffer.from(JSON.stringify({ day, seq: seal.seq, sealHash: seal.sealHash, sealedAt: seal.sealedAt }))
  );
  return seal;
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
  // Verification rides on the read that was happening anyway: the objects an
  // admin's date range already loads are exactly the ones to check, so a
  // tamper check costs no extra fetches.
  const loaded = [];
  for (const day of days) {
    const files = await loadAuditDay(bucket, day, 5000 - events.length);
    files.forEach((f) => Array.isArray(f.blob?.events) && events.push(...f.blob.events));
    let seal = await loadJsonObject(bucket, sealKey(day));
    if (!seal) {
      try {
        seal = await sealDayIfClosed(bucket, day, files, { known: null });
      } catch (e) {
        // A seal that could not be written is not a reason to withhold the
        // log. The day stays open and says so.
        console.error('audit seal failed (non-fatal):', e && e.message);
      }
    }
    loaded.push({ day, blobs: files, seal });
    if (events.length >= 5000) break;
  }

  let verdict;
  try {
    const head = await loadJsonObject(bucket, SEAL_HEAD_KEY);
    verdict = integrity.verify(loaded);
    verdict = {
      ...verdict,
      summary: integrity.summarise(verdict),
      // The head hash is the single value an admin should copy off-platform.
      // Internal consistency is all a self-hosted chain can prove; a hash
      // recorded elsewhere is what makes it evidence against someone who can
      // rewrite the whole store.
      headHash: (head && head.sealHash) || verdict.headHash,
      headDay: (head && head.day) || null,
    };
  } catch (e) {
    // Never let the integrity check take the audit trail away from the admin.
    console.error('audit verify failed (non-fatal):', e && e.message);
    verdict = { intact: null, problems: [], days: [], summary: 'Integrity could not be checked.' };
  }

  events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return json(res, 200, { events: events.slice(0, 5000), integrity: verdict });
}

// ── Action queue (statutory obligations across every open case) ────────────
//
// The Investigation Diary already lists what is missing from a case. This
// answers the question that list cannot: of everything missing across every
// case, what breaks first, and what happens when it does.
//
// Reads are capped. The queue is a working surface an officer opens each
// morning, not an archive report, and loading several hundred full records to
// render a page an officer scans for thirty seconds is the wrong trade. The
// cap is applied to the index, which is already newest-first.
const ACTION_QUEUE_CASE_CAP = 80;

/**
 * Build the obligation queue for one caller.
 *
 * Factored out of the HTTP handler because the assistant needs the same answer:
 * an officer asking "what's urgent on my cases?" in chat must get exactly what
 * the Action Queue page shows, not a second implementation that can drift from
 * it. One engine, one loader, two surfaces.
 */
async function buildActionQueue(bucket, { email, name }) {
  const index = await loadInvIndex(bucket);
  // Settled cases carry no live obligation, so they are dropped before the
  // record fetch rather than after — the cap should be spent on cases that can
  // still produce an alert.
  const openCases = index.filter((c) => !['Chargesheet Filed', 'Closed'].includes(String(c.status)));
  const live = openCases.slice(0, ACTION_QUEUE_CASE_CAP);

  const records = await Promise.all(
    live.map(async (c) => {
      try {
        const raw = await streamToString(await bucket.getObject(invKey(c.caseMasterId)));
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null; // one unreadable record must not blank the queue
      }
    }),
  );

  const queue = statutory.buildQueue(records.filter(Boolean), legalKb);

  // "Mine" is derived, not stored: there is no case-assignment model in the
  // record, so ownership is inferred from the IO name or the creator's address.
  // Reported as a hint for the UI's filter rather than used to withhold
  // anything — an investigator who can open the diary can already see these
  // cases, and silently hiding a custody clock because a name did not match
  // would be the worst possible failure of this feature.
  // Both sides must be non-empty before they can match. Without that guard an
  // officer whose email failed to resolve would compare '' against a record
  // with no createdBy, match every one of them, and see the entire station's
  // caseload under "Mine".
  const mineByEmail = (r) => !!email && String(r.createdBy || '').toLowerCase() === email;
  const mineByName = (r) => !!name && String(r.ioName || '').toLowerCase() === name.toLowerCase();
  const ownership = new Map(
    records.filter(Boolean).map((r) => [r.caseMasterId, mineByEmail(r) || mineByName(r)]),
  );

  return {
    obligations: queue.obligations.map((o) => ({ ...o, mine: ownership.get(o.caseMasterId) === true })),
    counts: queue.counts,
    scanned: records.filter(Boolean).length,
    capped: openCases.length > ACTION_QUEUE_CASE_CAP,
    generatedAt: Date.now(),
  };
}

async function handleActionQueue(req, res) {
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }
  const queue = await buildActionQueue(bucket, {
    email: String(caller?.email_id || '').toLowerCase(),
    name: [caller?.first_name, caller?.last_name].filter(Boolean).join(' '),
  });
  return json(res, 200, { ...queue, role });
}

// Acknowledge an obligation as handled off-system, or undo that.
//
// This exists because an alert that cannot be dismissed is an alert that gets
// ignored wholesale. The engine reads the record, not the world: a seizure memo
// filed on paper and never entered looks identical to one that was never made.
// Without a way to say "done, off-system", officers would learn to scroll past
// the whole panel — the single most likely way this feature dies.
//
// A reason is required, and the acknowledgement is kept and attributed rather
// than deleting the obligation, so a supervisor reviewing the queue sees what
// was waved through and by whom.
async function handleObligationAck(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }
  const caseMasterId = String(body.caseMasterId || '');
  const obligationId = String(body.obligationId || '');
  if (!caseMasterId || !obligationId) {
    return json(res, 400, { error: 'caseMasterId and obligationId are required' });
  }
  const undo = body.undo === true;
  const note = String(body.note || '').trim().slice(0, 300);
  if (!undo && !note) {
    return json(res, 400, { error: 'Say what was done — the note is what a supervisor reviews.' });
  }

  // Serialised per case: two obligations acknowledged at once on the same case
  // would otherwise be a read-modify-write race, and the later write would drop
  // the earlier acknowledgement with no error to either officer.
  const email = String(caller?.email_id || '').toLowerCase();
  const name = [caller?.first_name, caller?.last_name].filter(Boolean).join(' ');

  // Read-modify-write on the case record, and it races the same way
  // appendInvestigationEntry already does: two officers acting on the same case
  // in the same instant can have the later write drop the earlier change.
  // Stratus offers no compare-and-set to close that, and an in-process lock
  // would only serialise one container out of however many are warm — which
  // reads as a guarantee while providing none. So the window is narrowed
  // instead: the record is re-read immediately before the write and only the
  // single acknowledgement key is touched, leaving everything else as found.
  let rec;
  try {
    rec = JSON.parse((await streamToString(await bucket.getObject(invKey(caseMasterId)))) || 'null');
  } catch {
    rec = null;
  }
  if (!rec) return json(res, 404, { error: 'Investigation record not found' });

  const acks = rec.obligationAcks || (rec.obligationAcks = {});
  if (undo) delete acks[obligationId];
  else acks[obligationId] = { by: name || email, email, at: Date.now(), note };
  rec.updatedAt = Date.now();
  await bucket.putObject(invKey(caseMasterId), Buffer.from(JSON.stringify(rec)));

  await storeAuditEvents(req, app, bucket, [{
    action: undo ? 'reopen-obligation' : 'acknowledge-obligation',
    feature: 'Action Queue', path: '/action-queue',
    detail: `${rec.crimeNo || caseMasterId} · ${obligationId}${note ? ` — ${note}` : ''}`,
  }], caller);

  return json(res, 200, { ok: true });
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
    // Where the case is, carried so sunset can be computed for the right place.
    // Stored as null rather than 0 when absent: Number(null) is a perfectly
    // valid 0°N 0°E, and a coordinate defaulted to the Gulf of Guinea would put
    // every arrest five and a half hours out.
    latitude: Number.isFinite(Number(payload.latitude)) && payload.latitude !== null && payload.latitude !== ''
      ? Number(payload.latitude) : null,
    longitude: Number.isFinite(Number(payload.longitude)) && payload.longitude !== null && payload.longitude !== ''
      ? Number(payload.longitude) : null,
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

// ── One-time purge of the demonstration diaries ────────────────────────────
//
// TEMPORARY. The seeder is gone, but the diaries it opened on the Development
// deployment are still there. This removes them and is then removed itself —
// it exists for one run, not as a capability.
//
// The scope is the whole safety argument. It deletes ONLY records carrying
// `seeded: true`, a stamp nothing but the old seeder ever wrote, so a diary an
// officer filed is not merely unlikely to be caught by this — it cannot be.
// The caller does not get to name what is deleted, which is why there is no id
// parameter to get wrong.
//
// It also refuses to delete anything until asked twice: without `confirm`, it
// reports what it would remove and changes nothing.
const isSeededRecord = (rec) => !!rec && rec.seeded === true;

async function handleInvestigationPurgeSeeded(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  if (!caller || role !== 'admin') return json(res, 403, { error: 'Admin access required' });

  const index = await loadInvIndex(bucket);
  const matched = [];
  const kept = [];
  for (const c of index) {
    let rec = null;
    try {
      rec = JSON.parse((await streamToString(await bucket.getObject(invKey(c.caseMasterId)))) || 'null');
    } catch { rec = null; }
    // An index entry whose blob is missing or unreadable is left alone. This
    // deletes what it has read and confirmed, never what it has guessed at.
    if (isSeededRecord(rec)) matched.push({ caseMasterId: String(c.caseMasterId), crimeNo: c.crimeNo || '' });
    else kept.push(c);
  }

  if (body.confirm !== true) {
    return json(res, 200, {
      dryRun: true, matched: matched.length, cases: matched,
      note: 'Nothing was deleted. Send { "confirm": true } to remove these.',
    });
  }
  if (!matched.length) return json(res, 200, { deleted: 0, cases: [], note: 'No seeded diaries remain.' });

  const ids = new Set(matched.map((m) => m.caseMasterId));
  for (const m of matched) {
    try { await bucket.deleteObject(invKey(m.caseMasterId)); } catch { /* index is cleaned either way */ }
  }
  await saveInvIndex(bucket, kept);

  // The person index points names at cases. Leaving it alone would keep the
  // seeded names surfacing as cross-case "leads" against diaries that no
  // longer exist, so drop those references and any name left with none.
  try {
    const pidx = JSON.parse((await streamToString(await bucket.getObject(INV_PERSON_INDEX_KEY))) || '{}');
    if (pidx && pidx.people) {
      for (const name of Object.keys(pidx.people)) {
        pidx.people[name] = (pidx.people[name] || []).filter((a) => !ids.has(String(a.caseMasterId)));
        if (!pidx.people[name].length) delete pidx.people[name];
      }
      await bucket.putObject(INV_PERSON_INDEX_KEY, Buffer.from(JSON.stringify(pidx)));
    }
  } catch { /* the diaries are the record; a stale lead index is not worth failing over */ }

  await storeAuditEvents(req, app, bucket, [{
    action: 'purge-seeded-investigations', feature: 'Investigation Diary', path: '/investigation-diary',
    detail: `${matched.length} demonstration diaries deleted: ${matched.map((m) => m.crimeNo || m.caseMasterId).join(', ')}`,
  }], caller);

  return json(res, 200, { deleted: matched.length, cases: matched });
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
  const prose = await callLLM(
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

// ── Records Digitisation (paper files → searchable digital records) ─────────
// Police records still live largely on paper. Officers photograph or scan a
// document here; Zia OCR lifts the text, an LLM pass classifies it and pulls
// out key fields and any tabular data, and the result is stored so it can be
// read back, searched, and answered from by the assistant.
//
// Everything lives in Stratus (the project cannot create Data Store tables
// programmatically): the original image, one JSON record per document, and a
// small index so the gallery loads fast.
const DIG_PREFIX = 'digitise/';
const DIG_INDEX_KEY = 'digitise/index.json';
const digFileKey = (id, ext) => `${DIG_PREFIX}files/${id}.${ext}`;
const digRecKey = (id) => `${DIG_PREFIX}records/${id}.json`;

async function loadDigIndex(bucket) {
  try {
    const parsed = JSON.parse((await streamToString(await bucket.getObject(DIG_INDEX_KEY))) || '{}');
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch {
    return [];
  }
}
async function saveDigIndex(bucket, records) {
  await bucket.putObject(DIG_INDEX_KEY, Buffer.from(JSON.stringify({ records, updatedAt: Date.now() })));
}
const digSummary = (rec) => ({
  id: rec.id, batchId: rec.batchId || '', filename: rec.filename, mime: rec.mime,
  sourceKind: rec.sourceKind || 'scan',
  sourceBytes: rec.sourceBytes || 0,
  title: rec.title || rec.filename, docType: rec.docType || 'Unclassified',
  summary: rec.summary || '', tableCount: (rec.tables || []).length,
  pageCount: (rec.pages || []).length || 1,
  textLength: (rec.text || '').length, status: rec.status || 'processed',
  caseMasterId: rec.caseMasterId || '', crimeNo: rec.crimeNo || '',
  uploadedBy: rec.uploadedBy || '', uploadedByName: rec.uploadedByName || '',
  createdAt: rec.createdAt, updatedAt: rec.updatedAt,
});

// Ask the model to classify the page and pull out fields and tables. Strictly
// extractive: police records must never gain facts that were not on the paper.
const DIG_EXTRACT_SYSTEM =
  'You structure OCR text taken from a scanned Indian police document. Return ONLY a JSON object:\n' +
  '{"docType": string, "title": string, "summary": string, "fields": {label: value},\n' +
  ' "tables": [{"title": string, "columns": [string], "rows": [[string]]}]}\n' +
  'docType: one of FIR, Case Diary, Charge Sheet, Arrest Memo, Seizure Memo, Inquest/UDR, ' +
  'Missing Person, General Diary, Statement, Court Document, Correspondence, Register/Ledger, Other.\n' +
  'title: a short human label (include a crime/case number if visible).\n' +
  'summary: one or two sentences on what the document is.\n' +
  'fields: key particulars actually present (crime no., FIR no., dates, police station, ' +
  'district, sections of law, names, ranks). Omit anything not in the text.\n' +
  'tables: any tabular data you can reconstruct; use [] when the page has none.\n' +
  'COPY values verbatim from the OCR text. Never invent, infer or complete a value. ' +
  'If the text is too garbled to read, return empty fields and tables. Output JSON only.';

async function digStructure(text) {
  const empty = { docType: '', title: '', summary: '', fields: {}, tables: [] };
  if (!text || text.trim().length < 12) return empty;
  const raw = await callLLM(
    [
      { role: 'system', content: DIG_EXTRACT_SYSTEM },
      { role: 'user', content: text.slice(0, 12000) },
    ],
    { maxTokens: 1600, temperature: 0, timeoutMs: 20_000 }
  );
  if (!raw) return empty;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    const tables = (Array.isArray(parsed.tables) ? parsed.tables : []).slice(0, 12).map((t) => ({
      title: String(t.title || '').slice(0, 160),
      columns: (Array.isArray(t.columns) ? t.columns : []).slice(0, 20).map((c) => String(c).slice(0, 120)),
      rows: (Array.isArray(t.rows) ? t.rows : []).slice(0, 200)
        .map((r) => (Array.isArray(r) ? r.slice(0, 20).map((c) => String(c == null ? '' : c).slice(0, 500)) : [])),
    })).filter((t) => t.columns.length || t.rows.length);
    const fields = {};
    if (parsed.fields && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields)) {
      Object.entries(parsed.fields).slice(0, 40).forEach(([k, v]) => {
        if (v == null || v === '') return;
        fields[String(k).slice(0, 80)] = String(v).slice(0, 500);
      });
    }
    return {
      docType: String(parsed.docType || '').slice(0, 60),
      title: String(parsed.title || '').slice(0, 160),
      summary: String(parsed.summary || '').slice(0, 600),
      fields,
      tables,
    };
  } catch {
    return empty;
  }
}

// POST /digitise/upload?filename=&mime=&batchId=&caseMasterId=  body: hex bytes
async function handleDigitiseUpload(req, res) {
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }

  const filename = (urlParam(req, 'filename') || 'scan.jpg').slice(0, 180);
  const mimeParam = urlParam(req, 'mime');
  const mime = /^image\/(jpeg|png)$/.test(mimeParam) ? mimeParam : 'image/jpeg';
  const batchId = (urlParam(req, 'batchId') || '').slice(0, 40);
  const caseMasterId = (urlParam(req, 'caseMasterId') || '').slice(0, 80);
  // Adding a page to an existing document rather than filing a new one — the
  // Adobe-Scan pattern, where a physical file is several photographed pages.
  const appendTo = (urlParam(req, 'appendTo') || '').slice(0, 64);

  const hex = (await readBody(req)).trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return json(res, 400, { error: 'invalid encoding' });
  const buf = Buffer.from(hex, 'hex');
  if (!buf.length) return json(res, 400, { error: 'empty file' });
  if (buf.length > 8 * 1024 * 1024) return json(res, 413, { error: 'image too large (8MB max)' });

  const id = mediaId();
  const ext = MEDIA_EXT_BY_MIME[mime] || 'jpg';
  const key = digFileKey(id, ext);
  await bucket.putObject(key, buf);

  // Zia needs a real read stream (see handleOcr) — a bare Buffer is rejected.
  let text = '';
  let ocrError = '';
  const langParam = (urlParam(req, 'lang') || 'eng').toLowerCase();
  const ocrLang = ['eng', 'kan', 'hin'].includes(langParam) ? langParam : 'eng';
  const tmpPath = path.join(os.tmpdir(), `dig-${id}.${ext}`);
  try {
    fs.writeFileSync(tmpPath, buf);
    // `ocrLang`, not 'eng'.
    //
    // The language was being computed from the request and then thrown away —
    // every scan went to Zia as English, so a Kannada charge sheet came back as
    // transliterated nonsense in a product whose whole pitch includes Kannada.
    // Silent, too: OCR "succeeded" and produced text, just not the text on the
    // page, and the structuring pass downstream dutifully made fields out of it.
    const result = await app.zia().extractOpticalCharacters(
      fs.createReadStream(tmpPath),
      { modelType: 'OCR', language: ocrLang }
    );
    text = (result && result.text) || '';
  } catch (e) {
    ocrError = e.message || String(e);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
  }

  const now = Date.now();
  const page = { key, filename, mime, bytes: buf.length, text, addedAt: now };

  // Appending: fold the new page into the existing document and re-read the
  // whole thing, so fields and tables reflect every page rather than the first.
  if (appendTo) {
    let existing = null;
    try {
      existing = JSON.parse((await streamToString(await bucket.getObject(digRecKey(appendTo)))) || 'null');
    } catch { existing = null; }
    if (existing && !existing.deleted) {
      const pages = [...(existing.pages || []), page];
      const combined = pages.map((pg) => pg.text || '').filter(Boolean).join('\n\n');
      const restructured = combined ? await digStructure(combined) : null;
      const merged = {
        ...existing,
        pages,
        text: combined,
        bytes: pages.reduce((a, pg) => a + (pg.bytes || 0), 0),
        docType: (restructured && restructured.docType) || existing.docType,
        title: existing.titleEdited ? existing.title : ((restructured && restructured.title) || existing.title),
        summary: (restructured && restructured.summary) || existing.summary,
        fields: (restructured && Object.keys(restructured.fields).length) ? restructured.fields : existing.fields,
        tables: (restructured && restructured.tables.length) ? restructured.tables : existing.tables,
        status: combined ? 'processed' : existing.status,
        updatedAt: now,
      };
      await bucket.putObject(digRecKey(appendTo), Buffer.from(JSON.stringify(merged)));
      const idx0 = (await loadDigIndex(bucket)).filter((r) => r.id !== appendTo);
      idx0.push(digSummary(merged));
      await saveDigIndex(bucket, idx0);
      await storeAuditEvents(req, app, bucket, [{
        action: 'digitise-add-page', feature: 'Records', path: '/records', detail: filename,
      }], caller);
      return json(res, 200, { record: merged });
    }
    // The document vanished under us — fall through and file this as its own.
  }

  const structured = text ? await digStructure(text) : { docType: '', title: '', summary: '', fields: {}, tables: [] };
  const rec = {
    id,
    batchId,
    filename,
    mime,
    key,
    pages: [page],
    bytes: buf.length,
    text,
    docType: structured.docType || 'Unclassified',
    title: structured.title || filename,
    summary: structured.summary || '',
    fields: structured.fields,
    tables: structured.tables,
    caseMasterId,
    crimeNo: (structured.fields && (structured.fields['Crime No.'] || structured.fields['Crime No'] || structured.fields.crimeNo)) || '',
    status: ocrError ? 'ocr-failed' : 'processed',
    error: ocrError,
    uploadedBy: String(caller.email_id || '').toLowerCase(),
    uploadedByName: `${caller.first_name || ''} ${caller.last_name || ''}`.trim() || String(caller.email_id || ''),
    createdAt: now,
    updatedAt: now,
  };
  await bucket.putObject(digRecKey(id), Buffer.from(JSON.stringify(rec)));
  const idx = await loadDigIndex(bucket);
  idx.push(digSummary(rec));
  await saveDigIndex(bucket, idx);

  await storeAuditEvents(req, app, bucket, [{
    action: 'digitise-upload', feature: 'Records', path: '/records', detail: filename,
  }], caller);
  return json(res, 200, { record: rec });
}

// POST /digitise/ingest — file a record whose text did NOT come from OCR.
//
// Spreadsheets, documents, decks, text files and transcripts already contain
// their text; the browser extracts it (see utils/extract.js) and posts it
// here. Everything downstream is identical to a scan: the same AI structuring
// pass, the same record shape, the same search index. Only the way the text
// was obtained differs, and `sourceKind` records that honestly.
async function handleDigitiseIngest(req, res) {
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }

  const body = JSON.parse((await readBody(req)) || '{}');
  const filename = String(body.filename || 'document').slice(0, 180);
  const mime = String(body.mime || 'application/octet-stream').slice(0, 120);
  const sourceKind = String(body.sourceKind || 'file').slice(0, 24);
  const text = String(body.text || '');
  const note = String(body.note || '').slice(0, 300);
  const batchId = String(body.batchId || '').slice(0, 40);
  const caseMasterId = String(body.caseMasterId || '').slice(0, 80);
  if (!text.trim()) return json(res, 400, { error: 'no text was extracted from this file' });
  // Generous, but bounded: the structuring pass only reads the first 12k
  // anyway, and the rest is kept for search.
  if (text.length > 400_000) return json(res, 413, { error: 'extracted text too large (400k characters max)' });

  // Tables the client reconstructed (a spreadsheet's sheets). Sanitised to the
  // same shape and limits the AI pass produces, so both paths store alike.
  const tables = (Array.isArray(body.tables) ? body.tables : []).slice(0, 20).map((t) => ({
    title: String(t.title || '').slice(0, 160),
    columns: (Array.isArray(t.columns) ? t.columns : []).slice(0, 30).map((c) => String(c).slice(0, 120)),
    rows: (Array.isArray(t.rows) ? t.rows : []).slice(0, 500)
      .map((r) => (Array.isArray(r) ? r.slice(0, 30).map((c) => String(c == null ? '' : c).slice(0, 500)) : [])),
  })).filter((t) => t.columns.length || t.rows.length);

  const structured = await digStructure(text);
  const now = Date.now();
  const id = mediaId();
  const rec = {
    id,
    batchId,
    filename,
    mime,
    sourceKind,
    key: '',            // no stored original: the text IS the record here
    pages: [],
    bytes: Buffer.byteLength(text, 'utf8'),
    text,
    docType: structured.docType || 'Unclassified',
    title: structured.title || filename,
    summary: structured.summary || '',
    fields: structured.fields,
    // A spreadsheet's real sheets beat anything the model would reconstruct
    // from their flattened text, so client tables win when present.
    tables: tables.length ? tables : structured.tables,
    caseMasterId,
    crimeNo: (structured.fields && (structured.fields['Crime No.'] || structured.fields['Crime No'] || structured.fields.crimeNo)) || '',
    status: 'processed',
    error: '',
    note,
    uploadedBy: String(caller.email_id || '').toLowerCase(),
    uploadedByName: `${caller.first_name || ''} ${caller.last_name || ''}`.trim() || String(caller.email_id || ''),
    createdAt: now,
    updatedAt: now,
  };
  await bucket.putObject(digRecKey(id), Buffer.from(JSON.stringify(rec)));
  const idx = await loadDigIndex(bucket);
  idx.push(digSummary(rec));
  await saveDigIndex(bucket, idx);

  await storeAuditEvents(req, app, bucket, [{
    action: 'digitise-ingest', feature: 'Records', path: '/records',
    detail: `${filename} (${sourceKind}, ${text.length} chars)`,
  }], caller);
  return json(res, 200, { record: rec });
}

async function handleDigitise(req, res, action) {
  const body = action === 'list' ? {} : JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }

  if (action === 'list') {
    const records = await loadDigIndex(bucket);
    return json(res, 200, { records: records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) });
  }

  const id = String(body.id || '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return json(res, 400, { error: 'valid id is required' });

  if (action === 'get') {
    try {
      const rec = JSON.parse((await streamToString(await bucket.getObject(digRecKey(id)))) || 'null');
      if (!rec) return json(res, 404, { error: 'Record not found' });
      return json(res, 200, { record: rec });
    } catch {
      return json(res, 404, { error: 'Record not found' });
    }
  }

  if (action === 'delete') {
    try { await bucket.deleteObject(digRecKey(id)); } catch { /* keep going */ }
    await saveDigIndex(bucket, (await loadDigIndex(bucket)).filter((r) => r.id !== id));
    await storeAuditEvents(req, app, bucket, [{
      action: 'digitise-delete', feature: 'Records', path: '/records', detail: id,
    }], caller);
    return json(res, 200, { ok: true });
  }

  if (action === 'update') {
    let rec;
    try {
      rec = JSON.parse((await streamToString(await bucket.getObject(digRecKey(id)))) || 'null');
    } catch { rec = null; }
    if (!rec) return json(res, 404, { error: 'Record not found' });
    // Officers correct OCR mistakes; the original scan is untouched.
    if (typeof body.text === 'string') rec.text = body.text.slice(0, 200_000);
    if (typeof body.title === 'string') { rec.title = body.title.slice(0, 160); rec.titleEdited = true; }
    if (typeof body.docType === 'string') rec.docType = body.docType.slice(0, 60);
    if (typeof body.caseMasterId === 'string') rec.caseMasterId = body.caseMasterId.slice(0, 80);
    if (typeof body.crimeNo === 'string') rec.crimeNo = body.crimeNo.slice(0, 120);
    if (Array.isArray(body.tables)) rec.tables = body.tables.slice(0, 12);
    rec.updatedAt = Date.now();
    await bucket.putObject(digRecKey(id), Buffer.from(JSON.stringify(rec)));
    const idx = (await loadDigIndex(bucket)).filter((r) => r.id !== id);
    idx.push(digSummary(rec));
    await saveDigIndex(bucket, idx);
    return json(res, 200, { record: rec });
  }

  return json(res, 400, { error: 'unknown action' });
}

// Serves a stored scan to an authenticated officer. Evidence images are never
// reachable by public URL.
const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', amr: 'audio/amr',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4',
  webm: 'video/webm', '3gp': 'video/3gpp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel', csv: 'text/csv', tsv: 'text/tab-separated-values',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', xml: 'application/xml',
};
const mimeForKey = (key) =>
  MIME_BY_EXT[String(key).split('.').pop().toLowerCase()] || 'application/octet-stream';

// POST /digitise/source-url  { id, ext } -> { url, key }
//
// Hands the browser a short-lived pre-signed PUT so it can send the file
// STRAIGHT to Stratus. Routing a recording through the function meant
// hex-encoding it (doubling it on the wire), holding it in the function's
// memory, and doing it all inside a request budget shared with OCR and the
// model — fine for a photographed page, wrong for a 40-minute interview.
// Direct upload has none of those limits.
async function handleDigitiseSourceUrl(req, res) {
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }
  const body = JSON.parse((await readBody(req)) || '{}');
  const id = String(body.id || '').slice(0, 64);
  const ext = String(body.ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  if (!id) return json(res, 400, { error: 'id is required' });

  const key = digFileKey(id, ext);
  try {
    const signed = await bucket.generatePreSignedUrl(key, 'PUT', { expiryIn: '900' });
    const url = signed && (signed.signature || signed.url);
    if (!url) return json(res, 502, { error: 'no signed url returned' });
    return json(res, 200, { url, key });
  } catch (e) {
    // Reported, not hidden: the caller falls back to uploading through the
    // function, and knowing WHY the fast path was unavailable is the
    // difference between a one-line config fix and a guessing game.
    return json(res, 502, { error: 'presign failed: ' + ((e && e.message) || e) });
  }
}

// POST /digitise/source-done  { id, key } — record the upload after the
// browser has PUT the bytes. The object is verified server-side rather than
// taken on trust: a client that says it uploaded and did not would otherwise
// leave a record pointing at nothing.
async function handleDigitiseSourceDone(req, res) {
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }
  const body = JSON.parse((await readBody(req)) || '{}');
  const id = String(body.id || '').slice(0, 64);
  const key = confineKey(body.key, `${DIG_PREFIX}files/`);
  if (!id || !key) return json(res, 400, { error: 'id and key are required' });

  let bytes = 0;
  try {
    const head = await bucket.headObject(key);
    bytes = Number((head && (head.content_length || head.size)) || 0);
  } catch {
    return json(res, 404, { error: 'the upload did not arrive' });
  }
  return await finishSourceAttach(req, res, app, bucket, caller, id, key, bytes);
}

// Shared tail of both attach paths.
async function finishSourceAttach(req, res, app, bucket, caller, id, key, bytes) {
  let rec;
  try {
    rec = JSON.parse((await streamToString(await bucket.getObject(digRecKey(id)))) || 'null');
  } catch { rec = null; }
  if (!rec || rec.deleted) return json(res, 404, { error: 'record not found' });

  const merged = { ...rec, key, sourceBytes: bytes || rec.sourceBytes || 0, updatedAt: Date.now() };
  await bucket.putObject(digRecKey(id), Buffer.from(JSON.stringify(merged)));
  const idx = (await loadDigIndex(bucket)).filter((r) => r.id !== id);
  idx.push(digSummary(merged));
  await saveDigIndex(bucket, idx);
  await storeAuditEvents(req, app, bucket, [{
    action: 'digitise-source', feature: 'Records', path: '/records',
    detail: `${rec.filename} (${bytes} bytes)`,
  }], caller);
  return json(res, 200, { record: merged });
}

// POST /digitise/source?id=&ext=  body: hex bytes
// Attaches the ORIGINAL file to a record that was ingested as text. A
// transcript is not a substitute for the recording it came from — an officer
// needs to hear the voice, and a court will ask for the source — so the file
// is kept alongside the text it produced.
async function handleDigitiseSource(req, res) {
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }
  const id = (urlParam(req, 'id') || '').slice(0, 64);
  const ext = (urlParam(req, 'ext') || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  if (!id) return json(res, 400, { error: 'id is required' });

  const hex = (await readBody(req)).trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return json(res, 400, { error: 'invalid encoding' });
  const buf = Buffer.from(hex, 'hex');
  if (!buf.length) return json(res, 400, { error: 'empty file' });
  if (buf.length > 20 * 1024 * 1024) return json(res, 413, { error: 'file too large to keep (20MB max)' });

  const key = digFileKey(id, ext);
  await bucket.putObject(key, buf);
  return await finishSourceAttach(req, res, app, bucket, caller, id, key, buf.length);
}

async function handleDigitiseFile(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }
  const key = confineKey(body.key, `${DIG_PREFIX}files/`);
  if (!key) return json(res, 400, { error: 'invalid key' });
  try {
    const stream = await bucket.getObject(key);
    const chunks = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const buf = Buffer.concat(chunks);
    // The type is derived from the stored key, which carries the original
    // extension. Without it the browser gets image/jpeg for everything and a
    // recording will not play.
    return json(res, 200, { data: buf.toString('base64'), mime: mimeForKey(key) });
  } catch {
    return json(res, 404, { error: 'File not found' });
  }
}

// Keyword search across the digitised corpus. Used by the Records page and by
// the assistant, so officers can ask questions about scanned paper.
async function searchDigitised(bucket, query, limit = 6) {
  const q = String(query || '').toLowerCase().trim();
  if (q.length < 2) return [];
  const terms = [...new Set(q.split(/\s+/).filter((t) => t.length > 2))].slice(0, 8);
  if (!terms.length) return [];
  const index = await loadDigIndex(bucket);
  // Rank on the summary index first so only promising records are fetched.
  const shortlist = index
    .map((r) => {
      const hay = `${r.title} ${r.docType} ${r.summary} ${r.crimeNo} ${r.filename}`.toLowerCase();
      return { r, score: terms.reduce((n, t) => n + (hay.includes(t) ? 2 : 0), 0) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);

  const hits = [];
  for (const { r, score } of shortlist) {
    let rec;
    try {
      rec = JSON.parse((await streamToString(await bucket.getObject(digRecKey(r.id)))) || 'null');
    } catch { rec = null; }
    if (!rec) continue;
    const text = String(rec.text || '').toLowerCase();
    const textScore = terms.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0);
    const total = score + textScore;
    if (!total) continue;
    // A window around the first hit gives the assistant usable context.
    const first = terms.map((t) => text.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] || 0;
    hits.push({
      id: rec.id,
      title: rec.title,
      docType: rec.docType,
      filename: rec.filename,
      sourceKind: rec.sourceKind || 'scan',
      score: total,
      excerpt: String(rec.text || '').slice(Math.max(0, first - 200), Math.max(0, first - 200) + 900),
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Answer a question from the digitised paper records. Returns null when the
// scans have nothing to say, so callers can carry on to their normal source.
//
// Clearance is checked BEFORE retrieval rather than over the citation
// afterwards. Digitised paper is case material — statements, seizure memos,
// interview recordings — and canInvestigate is what gates it everywhere else
// in this function. Redacting only the source list would be theatre: the
// content would already be in the prompt, and from there in the answer.
async function answerFromDigitised(req, query, role) {
  if (!canInvestigate(role)) return null;
  try {
    const app = catalystSDK.initialize(req);
    const bucket = app.stratus().bucket(CONV_BUCKET);
    const hits = await searchDigitised(bucket, query, 4);
    if (!hits.length) return null;
    const KIND_NOTE = {
      scan: 'scanned paper, read by OCR',
      image: 'scanned paper, read by OCR',
      pdf: 'scanned PDF, read by OCR',
      sheet: 'spreadsheet',
      word: 'word-processed document',
      slides: 'presentation',
      text: 'text file',
      audio: 'transcript of an audio recording',
      video: 'transcript of a video recording',
    };
    const context = hits
      .map((h, i) =>
        `[${i + 1}] ${h.title} (${h.docType}, ${KIND_NOTE[h.sourceKind] || 'document'}, ` +
        `file ${h.filename}):\n${h.excerpt}`)
      .join('\n\n');
    const answer = await callLLM(
      [
        {
          role: 'system',
          content:
            'Answer strictly from these police records. Each is labelled with how it was captured: ' +
            'OCR of scanned paper (expect occasional garbled characters), a spreadsheet, a document, ' +
            'a presentation, or a TRANSCRIPT of a recording (expect spoken phrasing and the ' +
            'occasional misheard word — never quote a transcript as if it were a signed statement). ' +
            'Cite the bracketed source number after any statement drawn from a record. Never state ' +
            'anything the records do not contain; if they genuinely do not answer the question, ' +
            'reply exactly: NO_ANSWER',
        },
        { role: 'user', content: `Question: ${query}\n\nDocuments:\n${context}` },
      ],
      { maxTokens: 700, temperature: 0.2, timeoutMs: 15_000 }
    );
    if (!answer || !answer.trim() || /NO_ANSWER/i.test(answer) || isNegative(answer)) return null;
    // The hits themselves travel back, not just their labels. A citation is
    // only worth having if the officer can open the record behind it, and
    // that needs the record id and the passage that was actually read.
    return { text: answer.trim(), hits };
  } catch (e) {
    console.error('digitised answer failed (non-fatal):', e && e.message);
    return null;
  }
}

async function handleDigitiseSearch(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }
  const hits = await searchDigitised(bucket, body.query, Math.min(20, Number(body.limit) || 8));
  return json(res, 200, { hits });
}

// ── Report Studio (statutory & administrative report documents) ─────────────
// FIR, case diary, arrest memo, charge sheet, seizure memo, UDR, missing
// person, GD and management reports drafted in the Report Studio editor.
// Same record+index Stratus pattern as the Investigation Diary: one blob per
// report plus a small index blob so the hub lists fast. Deletion is soft (the
// blob is kept, flagged `deleted`) so a filed report can always be recovered.
const RPT_PREFIX = 'reports/studio/';
const RPT_INDEX_KEY = 'reports/studio-index.json';
const RPT_STATUSES = ['draft', 'final'];
const rptKey = (id) => `${RPT_PREFIX}${id}.json`;

async function loadRptIndex(bucket) {
  try {
    const parsed = JSON.parse((await streamToString(await bucket.getObject(RPT_INDEX_KEY))) || '{}');
    return Array.isArray(parsed.reports) ? parsed.reports : [];
  } catch {
    return [];
  }
}
async function saveRptIndex(bucket, reports) {
  await bucket.putObject(RPT_INDEX_KEY, Buffer.from(JSON.stringify({ reports, updatedAt: Date.now() })));
}
async function loadRptRecord(bucket, id) {
  try {
    return JSON.parse((await streamToString(await bucket.getObject(rptKey(id)))) || 'null');
  } catch {
    return null;
  }
}
const rptSummary = (rec) => ({
  id: rec.id, typeId: rec.typeId, title: rec.title, status: rec.status,
  refNo: rec.refNo || '', pageCount: (rec.pages || []).length,
  // Optional link to an Investigation Diary case, so the diary can list the
  // reports filed under it and the Studio can show which case a report serves.
  caseMasterId: rec.caseMasterId || '', crimeNo: rec.crimeNo || '',
  createdBy: rec.createdBy || '', createdByName: rec.createdByName || '',
  createdAt: rec.createdAt, updatedAt: rec.updatedAt,
});

async function handleReportDocs(req, res, action) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  // Same authenticated-role gate as the Investigation Diary (myRole fails open
  // to 'investigator' for role-less users, so !caller must be checked too).
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }

  if (action === 'list') {
    const reports = await loadRptIndex(bucket);
    return json(res, 200, { reports: reports.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) });
  }

  const id = String(body.id || '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return json(res, 400, { error: 'valid id is required' });

  if (action === 'get') {
    const rec = await loadRptRecord(bucket, id);
    if (!rec || rec.deleted) return json(res, 404, { error: 'Report not found' });
    return json(res, 200, { report: rec });
  }

  if (action === 'delete') {
    const rec = await loadRptRecord(bucket, id);
    if (rec && !rec.deleted) {
      await bucket.putObject(rptKey(id), Buffer.from(JSON.stringify({ ...rec, deleted: true, updatedAt: Date.now() })));
    }
    await saveRptIndex(bucket, (await loadRptIndex(bucket)).filter((r) => r.id !== id));
    await storeAuditEvents(req, app, bucket, [{
      action: 'delete-report', feature: 'Report Studio', path: '/report-studio',
      detail: (rec && rec.title) || id,
    }], caller);
    return json(res, 200, { ok: true });
  }

  // save (create or update). The editor autosaves, so only meaningful
  // transitions (creation, finalize/reopen) land in the audit trail.
  const typeId = String(body.typeId || '').slice(0, 40);
  if (!typeId) return json(res, 400, { error: 'typeId is required' });
  const pages = (Array.isArray(body.pages) ? body.pages : []).slice(0, 60).map((p) => {
    const page = {
      uid: String((p && p.uid) || '').slice(0, 40),
      sheetId: String((p && p.sheetId) || '').slice(0, 60),
      values: p && p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? p.values : {},
    };
    // Blank pages are rich documents: `doc` is the editor's ProseMirror JSON
    // (authoritative for re-editing) and `html` its rendered form, which the
    // PDF pipeline consumes directly.
    if (p && p.doc && typeof p.doc === 'object') page.doc = p.doc;
    if (p && typeof p.html === 'string') page.html = p.html.slice(0, 400_000);
    // Legacy free-layout pages (absolutely positioned elements) still load.
    if (Array.isArray(p && p.elements)) {
      page.elements = p.elements.slice(0, 120).filter((el) => el && typeof el === 'object');
    }
    return page;
  });
  if (JSON.stringify(pages).length > 900_000) return json(res, 413, { error: 'Report too large' });

  let existing = await loadRptRecord(bucket, id);
  if (existing && existing.deleted) existing = null;
  const now = Date.now();
  const rec = {
    id,
    typeId,
    title: String(body.title || 'Untitled report').slice(0, 160),
    status: RPT_STATUSES.includes(body.status) ? body.status : 'draft',
    refNo: String(body.refNo || '').slice(0, 80),
    caseMasterId: String(body.caseMasterId || '').slice(0, 80),
    crimeNo: String(body.crimeNo || '').slice(0, 120),
    pages,
    createdBy: existing ? existing.createdBy : String(caller.email_id || '').toLowerCase(),
    createdByName: existing
      ? existing.createdByName
      : `${caller.first_name || ''} ${caller.last_name || ''}`.trim() || String(caller.email_id || ''),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  await bucket.putObject(rptKey(id), Buffer.from(JSON.stringify(rec)));
  const idx = (await loadRptIndex(bucket)).filter((r) => r.id !== id);
  idx.push(rptSummary(rec));
  await saveRptIndex(bucket, idx);

  const events = [];
  if (!existing) {
    events.push({ action: 'create-report', feature: 'Report Studio', path: '/report-studio', detail: rec.title });
  } else if (existing.status !== rec.status) {
    events.push({
      action: rec.status === 'final' ? 'finalize-report' : 'reopen-report',
      feature: 'Report Studio', path: '/report-studio', detail: rec.title,
    });
  }
  if (events.length) await storeAuditEvents(req, app, bucket, events, caller);
  return json(res, 200, { report: rec });
}

// AI narrative polish: rewrites a drafted section in formal report language.
// Facts are preserved by instruction; the officer reviews before it is saved,
// and the original text stays one click away (Undo) in the editor.
async function handleReportAi(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  if (!caller || !canInvestigate(role)) {
    return json(res, 403, { error: 'Investigator, supervisor or admin access required' });
  }
  const text = String(body.text || '').slice(0, 6000);
  if (!text.trim()) return json(res, 400, { error: 'text is required' });
  const label = String(body.label || 'narrative').slice(0, 140);
  const reportName = String(body.reportName || 'police report').slice(0, 80);
  const messages = [
    {
      role: 'system',
      content:
        'You polish draft text for formal Indian police reports. Rewrite the given draft into clear, ' +
        'formal, precise report language appropriate to the stated section of the stated report. ' +
        'Preserve every fact, name, number, date, section of law and place EXACTLY — never invent, add ' +
        'or drop facts. Keep roughly the same length. Output ONLY the rewritten text, no preamble.',
    },
    { role: 'user', content: `Report: ${reportName}\nSection: ${label}\n\nDraft:\n${text}` },
  ];
  // Belt-and-braces: the provider chain already downgrades on day caps and
  // retired models and moves on to the next provider, but a transient timeout
  // or per-minute 429 can still surface as null — so retry on the cheap tier
  // explicitly, then once more after a cool-off.
  let prose = await callLLM(messages, { maxTokens: 900, temperature: 0.2, timeoutMs: 15_000 });
  if (!prose) prose = await callLLM(messages, { maxTokens: 900, temperature: 0.2, timeoutMs: 12_000, model: GROQ_MODEL_FAST });
  if (!prose) {
    await new Promise((s) => setTimeout(s, 2_000));
    prose = await callLLM(messages, { maxTokens: 900, temperature: 0.2, timeoutMs: 12_000, model: GROQ_MODEL_FAST });
  }
  if (!prose) return json(res, 503, { error: 'AI assist is unavailable right now — try again shortly' });
  await storeAuditEvents(req, app, bucket, [{
    action: 'ai-polish', feature: 'Report Studio', path: '/report-studio', detail: label,
  }], caller);
  return json(res, 200, { text: prose.trim() });
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
  const key = confineKey(body.key, MEDIA_PREFIX);
  if (!key) return json(res, 400, { error: 'invalid key' });
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

// Fast Vision Pre-Parser endpoint. The client calls this the moment a file is
// attached, so the parse overlaps with the officer still typing their question
// and costs no perceptible time when they hit send.
async function handleVisionParse(req, res) {
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const caller = await requestUser(app);
  // Vision runs against evidence, so it needs a real signed-in caller. Unlike
  // the navigation guards this does not fail open.
  if (!caller) return json(res, 403, { error: 'Sign-in required' });

  const filename = (urlParam(req, 'filename') || 'image.jpg').slice(0, 120);
  const mimeParam = urlParam(req, 'mime');
  const mime = /^image\/(jpeg|png)$/.test(mimeParam) ? mimeParam : 'image/jpeg';

  const hex = (await readBody(req)).trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return json(res, 400, { error: 'invalid encoding' });
  const buf = Buffer.from(hex, 'hex');
  if (!buf.length) return json(res, 400, { error: 'empty file' });
  if (buf.length > 8 * 1024 * 1024) return json(res, 413, { error: 'image too large (8MB max)' });

  const digest = await vision.preParse(app.zia(), buf, mime, filename);

  // The digest is returned to the browser, so it is redacted HERE as well as
  // when it is later placed in a prompt. A caller without clearance must not
  // receive identifiers off a scanned page just because they attached it.
  const { role } = await myRole(app, bucket);
  const clearance = caller ? role : null;
  if (digest.text) {
    const f = redaction.filterText(digest.text, clearance);
    digest.text = f.text;
    if (f.redactions.length) digest.redacted = redaction.describe(f.redactions);
  }

  await storeAuditEvents(req, app, bucket, [{
    action: 'vision-preparse', feature: 'Assistant', path: '/assistant',
    detail: `${filename} type=${digest.doc_type || 'unclassified'}` +
      `${digest.graphic ? ' flagged=' + digest.graphic : ''}` +
      `${digest.redacted ? ' redacted=' + digest.redacted : ''}`,
  }], caller);

  return json(res, 200, { digest });
}

// ── Officer memory ─────────────────────────────────────────────────────────
//
// Sentinel has no badge-number field, so the signed-in account is the identity
// every memory row is partitioned by — the same key the audit trail already
// uses. Partitioning by it is what makes memory per-officer: one officer's
// memory is not merely filtered out of another's queries, it is in a different
// partition and never read.
const memoryBadge = (caller) => String((caller && caller.email_id) || '').toLowerCase() || null;

// The QuickML knowledge-base document endpoint, for pushing a consolidated
// summary into semantic memory. Left unset by default: until it is configured,
// consolidation still writes structured facts and summaries to NoSQL, and
// recall ranks those instead — so memory works without it, and gains
// meaning-based search when it is set.
//   MEMORY_KB_URL     POST endpoint that creates a knowledge-base document
//   MEMORY_KB_DELETE  DELETE endpoint template, {id} substituted
const MEMORY_KB_URL = process.env.MEMORY_KB_URL || '';
const MEMORY_KB_DELETE = process.env.MEMORY_KB_DELETE || '';

async function summarizeForMemory(systemPrompt, transcript) {
  return callLLM(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: transcript },
    ],
    // Fast model on purpose: consolidation runs off the answer path and should
    // never compete with officers' questions for the big model's day cap.
    { maxTokens: 500, temperature: 0.2, timeoutMs: 15_000, model: GROQ_MODEL_FAST }
  );
}

async function pushMemoryToKb({ badgeId, sessionId, summary, transcript }) {
  if (!MEMORY_KB_URL) return null;
  const token = await getAccessToken();
  const r = await fetch(MEMORY_KB_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CATALYST-ORG': ORG,
      Authorization: `Zoho-oauthtoken ${token}`,
    },
    body: JSON.stringify({
      name: `officer-memory/${badgeId}/${sessionId}`,
      content: `Conversation with ${badgeId} on ${new Date().toISOString().slice(0, 10)}.\n\n${summary}\n\n${transcript.slice(0, 20_000)}`,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`kb push failed: ${r.status}`);
  return d.document_id || d.id || (d.data && (d.data.document_id || d.data.id)) || null;
}

async function dropMemoryKb(documentId) {
  if (!MEMORY_KB_DELETE) return false;
  const token = await getAccessToken();
  const r = await fetch(MEMORY_KB_DELETE.replace('{id}', encodeURIComponent(documentId)), {
    method: 'DELETE',
    headers: { 'CATALYST-ORG': ORG, Authorization: `Zoho-oauthtoken ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return r.ok;
}

async function runConsolidation(req, app, bucket, sessionId, badgeId, caller) {
  const result = await memory.consolidate(app, {
    sessionId,
    badgeId,
    summarize: summarizeForMemory,
    pushKb: MEMORY_KB_URL ? pushMemoryToKb : undefined,
  });
  if (!result) return null;
  await storeAuditEvents(req, app, bucket, [{
    action: 'memory-consolidate',
    feature: 'Assistant',
    path: '/assistant',
    detail: `session=${sessionId} type=long-term facts=${result.facts} kb=${result.kb_document_id || 'none'}`,
  }], caller);
  return result;
}

async function handleMemory(req, res, action) {
  const app = catalystSDK.initialize(req);
  const bucket = app.stratus().bucket(CONV_BUCKET);
  const { role, caller } = await myRole(app, bucket);
  const self = memoryBadge(caller);
  // Memory is personal data about a named officer. An unidentified caller has
  // no memory to read and none to delete.
  if (!self) return json(res, 401, { error: 'Sign in to manage your assistant memory.' });
  const body = JSON.parse((await readBody(req)) || '{}');

  // An admin may act on another officer's memory (a sealed case, an expunged
  // record); everyone else acts only on their own, whatever they ask for.
  const target = role === 'admin' && body.badge_id
    ? String(body.badge_id).toLowerCase().slice(0, 120)
    : self;

  if (action === 'get') {
    const facts = await memory.readFacts(app, target, { limit: 200 });
    const sessions = memory.sessionsOf(facts);
    return json(res, 200, {
      badge_id: target,
      idle_window_minutes: memory.IDLE_MINUTES,
      sessions: sessions.length,
      kb_documents: await memory.kbDocuments(app, target),
      facts: facts
        .filter((f) => !String(f.memory_key).startsWith('session#'))
        .map((f) => ({
          memory_key: f.memory_key,
          kind: f.kind,
          value: f.value,
          updated_at: Number(f.updated_at) || null,
          expires_at: Number(f.expires_at) || null,
        })),
    });
  }

  if (action === 'consolidate') {
    const sessionId = String(body.session_id || '').trim().slice(0, 80);
    if (!sessionId) return json(res, 400, { error: 'session_id is required' });
    const result = await runConsolidation(req, app, bucket, sessionId, target, caller);
    return json(res, 200, { ok: true, consolidated: !!result, ...(result || {}) });
  }

  if (action === 'forget') {
    const match = body.match ? String(body.match).slice(0, 120) : '';
    const removed = await memory.forget(app, target, {
      match: match || undefined,
      dropKb: MEMORY_KB_DELETE ? dropMemoryKb : undefined,
    });
    // Deletion is the one memory operation a reviewer is most likely to be
    // asked about later, so it is recorded even though the memory is gone.
    await storeAuditEvents(req, app, bucket, [{
      action: 'memory-delete',
      feature: 'Assistant',
      path: '/assistant',
      detail:
        `badge=${target}${target !== self ? ' (by admin)' : ''} ` +
        `scope=${match || 'all'} facts=${removed.facts} turns=${removed.turns} kb=${removed.kb_documents}`,
    }], caller);
    // A KB document that could not be deleted is stated plainly rather than
    // reported as a clean wipe — "your memory was cleared" has to be true.
    const kbPending = (await memory.kbDocuments(app, target)).length;
    return json(res, 200, { ok: true, ...removed, kb_documents_remaining: kbPending });
  }

  return json(res, 404, { error: 'unknown memory action' });
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
    const path = req.url ? req.url.split('?')[0].replace(/\/+$/, '') : '';

    // Health check — the ONE route ahead of the session gate.
    //
    // It exists so a deploy can be verified. Deploying this function with an
    // env_variables map overwrites what is set in the Catalyst console, and a
    // deploy that silently cleared GROQ_API_KEY would leave an assistant that
    // starts, returns 200, and has quietly lost every model lane. CI asserts
    // against this after each deploy.
    //
    // It reports whether configuration is PRESENT, never any value, and no
    // identity, record or user data passes through it. That an LLM provider is
    // configured is of no use to an attacker; a deploy that quietly disarmed
    // the assistant is of considerable use to us.
    if (path.endsWith('/health')) {
      return json(res, 200, {
        ok: true,
        providers: {
          groq: !!process.env.GROQ_API_KEY,
          claude: !!process.env.ANTHROPIC_API_KEY,
          order: PROVIDER_ORDER,
        },
        rag: !!(process.env.RAG_REFRESH_TOKEN || process.env.RAG_ACCESS_TOKEN),
      });
    }

    // Cheapest check first: a blocked source is turned away before it costs a
    // session lookup, and before it reaches any handler.
    const ip = clientIp(req);
    if (ipBlocked(ip)) {
      console.warn('blocked request from', ip);
      return json(res, 403, { error: 'Access denied.' });
    }

    // Cross-site callers are turned away before the session is even looked up:
    // a forged request should cost us nothing. See originAllowed above.
    if (!originAllowed(req.headers && req.headers.origin)) {
      console.warn('blocked cross-origin request from', req.headers.origin);
      return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
    }

    // One gate, ahead of every route. See requireSession above for why this is
    // the router's job and not each handler's.
    const session = await requireSession(req, res);
    if (!session) return undefined;
    const wait = rateLimited(
      `${session.email}:${METERED_ROUTES.test(path) ? 'metered' : 'general'}`,
      METERED_ROUTES.test(path) ? RATE_METERED : RATE_GENERAL
    );
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      return json(res, 429, { error: `Too many requests — try again in ${wait}s.` });
    }

    if (path.endsWith('/transcribe')) return await handleTranscribe(req, res);
    if (path.endsWith('/report-pdf')) return await handleReportPdf(req, res);
    if (path.endsWith('/support')) return await handleSupport(req, res);
    if (path.endsWith('/forecast/refresh')) return await handleForecast(req, res, true);
    if (path.endsWith('/forecast')) return await handleForecast(req, res, false);
    {
      const pm = path.match(/\/predict\/([a-z]+)$/);
      if (pm) return await handlePredict(req, res, pm[1]);
    }
    if (path.endsWith('/custody/list')) return await handleCustody(req, res, 'list');
    if (path.endsWith('/custody/save')) return await handleCustody(req, res, 'save');
    if (path.endsWith('/custody/seed')) return await handleCustody(req, res, 'seed');
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
    if (path.endsWith('/investigation/actions')) return await handleActionQueue(req, res);
    if (path.endsWith('/investigation/purge-seeded')) return await handleInvestigationPurgeSeeded(req, res);
    if (path.endsWith('/investigation/obligation-ack')) return await handleObligationAck(req, res);
    if (path.endsWith('/investigation/list')) return await handleInvestigation(req, res, 'list');
    if (path.endsWith('/investigation/get')) return await handleInvestigation(req, res, 'get');
    if (path.endsWith('/investigation/create')) return await handleInvestigation(req, res, 'create');
    if (path.endsWith('/investigation/status')) return await handleInvestigation(req, res, 'status');
    if (path.endsWith('/investigation/append')) return await handleInvestigation(req, res, 'append');
    if (path.endsWith('/investigation/update')) return await handleInvestigation(req, res, 'update');
    if (path.endsWith('/investigation/delete')) return await handleInvestigation(req, res, 'delete');
    if (path.endsWith('/digitise/upload')) return await handleDigitiseUpload(req, res);
    if (path.endsWith('/digitise/ingest')) return await handleDigitiseIngest(req, res);
    if (path.endsWith('/digitise/list')) return await handleDigitise(req, res, 'list');
    if (path.endsWith('/digitise/get')) return await handleDigitise(req, res, 'get');
    if (path.endsWith('/digitise/update')) return await handleDigitise(req, res, 'update');
    if (path.endsWith('/digitise/delete')) return await handleDigitise(req, res, 'delete');
    if (path.endsWith('/digitise/file')) return await handleDigitiseFile(req, res);
    if (path.endsWith('/digitise/source-url')) return await handleDigitiseSourceUrl(req, res);
    if (path.endsWith('/digitise/source-done')) return await handleDigitiseSourceDone(req, res);
    if (path.endsWith('/digitise/source')) return await handleDigitiseSource(req, res);
    if (path.endsWith('/digitise/search')) return await handleDigitiseSearch(req, res);
    if (path.endsWith('/reportdocs/list')) return await handleReportDocs(req, res, 'list');
    if (path.endsWith('/reportdocs/get')) return await handleReportDocs(req, res, 'get');
    if (path.endsWith('/reportdocs/save')) return await handleReportDocs(req, res, 'save');
    if (path.endsWith('/reportdocs/delete')) return await handleReportDocs(req, res, 'delete');
    if (path.endsWith('/reportdocs/ai')) return await handleReportAi(req, res);
    if (path.endsWith('/investigation/reorder')) return await handleInvestigation(req, res, 'reorder');
    if (path.endsWith('/investigation/summarize')) return await handleInvestigationSummary(req, res);
    if (path.endsWith('/investigation/media/upload')) return await handleMediaUpload(req, res);
    if (path.endsWith('/investigation/media/get')) return await handleMediaGet(req, res);
    if (path.endsWith('/investigation/ocr')) return await handleOcr(req, res);
    if (path.endsWith('/vision/parse')) return await handleVisionParse(req, res);
    if (path.endsWith('/memory/get')) return await handleMemory(req, res, 'get');
    if (path.endsWith('/memory/consolidate')) return await handleMemory(req, res, 'consolidate');
    if (path.endsWith('/memory/forget')) return await handleMemory(req, res, 'forget');

    const body = JSON.parse((await readBody(req)) || '{}');
    const rawQuery = (body.query || '').trim();
    if (!rawQuery) return json(res, 400, { error: 'query is required' });

    // Multilingual entry point. Everything downstream — routing, ZCQL, RAG —
    // works on English; the officer's language is carried through and applied
    // to the answer at the very end.
    const preferredLang = SUPPORTED_LANGS.includes(body.preferred_lang) ? body.preferred_lang : 'en';
    const lid = detectLang(rawQuery, preferredLang);
    const responseLang = lid.lang;

    const startedAt = Date.now();
    const responseId = `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    let routeDecision = null; // route + confidence, carried into the audit record
    let fanoutRag = null; // in-flight RAG call when the route is BOTH
    let redactionLog = []; // what the clearance filter removed, for the audit record
    // Guardrail state for this turn, carried into the audit record. An attempt
    // nobody can see afterwards is worse than one that half-works, so this is
    // logged whether or not it changed the answer.
    const inputScan = guard.scanInput(rawQuery);
    let threatLog = inputScan.findings.map((f) => ({ ...f, stage: 'input' }));
    let citedSources = []; // unified attribution for this answer, carried into the audit record
    // Everything retrieved for this answer, in whatever shape the lane that
    // ran produced it. Fed at the RETRIEVAL points rather than passed to
    // respondWith, so a new return site cannot silently skip the grounding
    // check by forgetting an argument.
    const evidence = grounding.collector();
    let groundingResult = null; // the verdict, shared with the decision record
    // Break-glass. The officer's stated purpose for reaching victim or
    // complainant identity on an offence against a woman or a child. Never
    // validated — it is recorded. See redaction.js for why the record, rather
    // than a parser, is the control.
    const accessReason = String(body.access_reason || '').trim().slice(0, 300);
    const access = accessReason ? { reason: accessReason } : null;
    const protectedReaches = []; // every protected reach this turn, granted or not
    // Mirrors `history`, which is declared further down — the slash-command
    // lanes return through respondWith BEFORE that declaration runs, and
    // reading a `let` from its temporal dead zone throws. Those lanes have no
    // history to consider anyway; the point is that the grounding check must
    // not be the thing that breaks them.
    let turnHistory = [];
    let ragCited = []; // set when a BOTH fan-out contributed knowledge-base prose
    let validatorChecks = []; // what the ZCQL validator verified or refused
    let slashName = null; // set when the query was an explicit /command
    let digitisedPromise = null; // in-flight search of the station's own uploads

    // Officer memory. Assembled before the router runs and written back on the
    // way out, so every lane — RAG, ZCQL, chat, attachments — inherits the same
    // conversation context without having to know memory exists.
    const sessionId = typeof body.session_id === 'string' ? body.session_id.trim().slice(0, 80) : '';
    let memBuffer = null; // the live cache buffer for this session
    let memFacts = []; // long-term structured facts for this officer
    let memRecall = null; // semantic recall, only when the question asked for it

    // Who is asking, for the clearance filter. Resolved once and memoised:
    // every redaction decision below depends on it.
    //
    // This deliberately does NOT reuse myRole()'s fail-open default. myRole
    // falls back to 'investigator' so a cold start never locks anyone out of
    // the UI — sensible for navigation, wrong for disclosure. Here an
    // unidentified caller gets no clearance at all, so an identity lookup that
    // fails redacts more rather than less.
    let callerRole = null;
    let callerUser = null;
    let clearanceApp = null;
    let clearanceBucket = null;
    const resolveCaller = async () => {
      if (clearanceApp) return callerRole;
      clearanceApp = catalystSDK.initialize(req);
      clearanceBucket = clearanceApp.stratus().bucket(CONV_BUCKET);
      try {
        const { role, caller } = await myRole(clearanceApp, clearanceBucket);
        // A caller the platform could not identify stays at zero clearance.
        callerUser = caller || null;
        callerRole = caller ? role : null;
      } catch {
        callerRole = null;
      }
      return callerRole;
    };

    // Post-generation guardrail (tier 2). Tier 1 already kept unauthorised
    // data out of the prompt; this catches an identifier the model restated or
    // inferred rather than copied. Every answer leaving this handler goes
    // through it.
    // Set by finalAnswer to the language the answer is ACTUALLY in, which is
    // not always the one that was asked for.
    let deliveredLang = null;

    const finalAnswer = async (text, lang) => {
      const localised = await localiseAnswer(text, lang);
      // localiseAnswer falls back to the English text when the model call
      // fails, which is right — an English answer beats no answer. But then
      // reporting response_lang: 'kn' is a lie the client acts on, and the
      // officer is left wondering why the interface switched languages on
      // them. So the delivered language is what the script says it is.
      deliveredLang = SCRIPT[lang] && !SCRIPT[lang].test(localised) && /[A-Za-z]{4}/.test(localised)
        ? 'en'
        : lang;
      const g = redaction.guardAnswer(localised, await resolveCaller());
      if (g.redactions.length) {
        redactionLog = redactionLog.concat(
          g.redactions.map((r) => ({ ...r, stage: 'post-generation' }))
        );
      }
      // Memory records the answer the officer actually received — after the
      // tier-2 guard, never the unguarded draft. Ahead of the decision record
      // so the memory write rides in the same audit batch as the answer,
      // rather than doubling the per-turn write to the audit trail.
      await rememberTurn(g.answer);
      await recordDecision();
      return g.answer;
    };

    // Immutable decision record. Every assistant answer leaves one audit event
    // describing HOW it was reached — the route and the confidence behind it,
    // what the caller was looking at, what the ZCQL validator allowed or
    // refused, and what the clearance filter removed. Written once per
    // request; a reviewer can reconstruct the decision without the answer.
    const memoryAudit = []; // memory writes, batched into the decision record
    let decisionRecorded = false;
    async function recordDecision() {
      if (decisionRecorded) return;
      decisionRecorded = true;
      try {
        await resolveCaller();
        const pc = body.page_context && typeof body.page_context === 'object' ? body.page_context : null;
        const parts = [
          routeDecision
            ? `route=${routeDecision.route} conf=${routeDecision.confidence.toFixed(2)} by=${routeDecision.decided_by}`
            : 'route=none',
          slashName ? `command=/${slashName}` : null,
          `lang=${lid.lang}`,
          `clearance=${callerRole || 'none'}`,
          pc && pc.current_module ? `page=${pc.current_module}` : null,
          validatorChecks.length ? `validator=${validatorChecks.join('|')}` : null,
          redactionLog.length ? `redacted=${redaction.describe(redactionLog)}` : 'redacted=none',
          citedSources.length ? `sources=${attribution.auditLine(citedSources)}` : 'sources=none',
          groundingResult && !groundingResult.grounded
            ? `grounding=FLAGGED:${groundingResult.unsupported.map((u) => u.value).join(',') || 'contradiction'}`
            : groundingResult ? 'grounding=ok' : null,
          // Every guardrail hit this turn — an override attempt in the
          // officer's message, injection markers inside an attached file or a
          // scanned page, an answer withheld. Recorded whether or not it
          // changed anything, because a pattern of attempts across sessions is
          // the signal a single blocked turn cannot give.
          threatLog.length ? `guardrail=${guard.summarise(threatLog)}` : null,
        ].filter(Boolean);
        const protectedEvents = protectedReaches.map((pa) => ({
          action: pa.granted ? 'protected-access-granted' : 'protected-access-refused',
          feature: 'Assistant',
          path: (pc && pc.current_module) || '/assistant',
          detail: [
            `rows=${pa.rows}`,
            `cleared=${pa.cleared ? 'yes' : 'no'}`,
            pa.granted ? `reason=${pa.reason}` : 'reason=none stated',
            pa.granted ? 'identity=released' : `identity=withheld(${pa.fieldsWithheld})`,
          ].join(' '),
        }));
        await storeAuditEvents(req, clearanceApp, clearanceBucket, [{
          action: 'assistant-query',
          feature: 'Assistant',
          path: (pc && pc.current_module) || '/assistant',
          detail: parts.join(' '),
          // The detail column is capped; the array itself is stored whole.
          sources: attribution.forAudit(citedSources),
        }, ...protectedEvents, ...memoryAudit], callerUser);
      } catch {
        // Auditing must never take an answer away from the officer.
      }
    }

    // Sentinel has no badge-number field. The signed-in account is the
    // identity every other audit event in this function is keyed on, so the
    // contract's badge_id carries that rather than inventing a number.
    const badgeId = () => (callerUser && callerUser.email_id) || null;

    // Which lanes actually contributed — not which one the router picked. A
    // BOTH question that found no records was answered by the knowledge base
    // alone, and the metric should say so.
    const pipelineRoute = (source, list) => {
      const kinds = new Set((list || []).map((c) => c.source_type));
      if (kinds.has(attribution.TYPES.DATABASE_RECORD) && kinds.has(attribution.TYPES.RAG_DOCUMENT)) {
        return 'HYBRID_RAG_ZCQL';
      }
      return String(source || 'unknown').toUpperCase().replace(/-/g, '_');
    };

    // Knowledge-base attribution. The retrieval payload is the only place the
    // document behind a RAG answer is named; when it names none, the corpus
    // itself is still provenance worth stating, because an uncited answer
    // reads as the model's own opinion.
    const ragCitations = (r) => {
      const nodes = (r && r.ok && r.data && r.data.retrieved_nodes) || [];
      evidence.add(nodes);
      const cited = attribution.fromRagNodes(nodes);
      return cited.length ? cited : attribution.knowledgeBaseFallback();
    };

    // Every answer leaves through here.
    //
    // Attribution, the clearance filter over it, tier-2 redaction, the audit
    // event and the response contract used to be assembled separately at each
    // of a dozen return sites — which is how English answers on the main path
    // came to skip finalAnswer entirely, taking the tier-2 guard and the
    // decision record with them. One exit makes that class of drift
    // impossible.
    const respondWith = async (rawText, payload = {}, citations) => {
      let text = rawText;
      const merged = attribution.merge(...(citations || []));
      const guarded = attribution.clearanceFilter(merged, await resolveCaller());
      if (guarded.removed.length) {
        redactionLog = redactionLog.concat(
          guarded.removed.map((field) => ({ field, count: 1, stage: 'citation' }))
        );
      }
      citedSources = guarded.sources;
      // Did the answer stay inside what was read? Run on the PRE-localisation
      // English text, for the same reason isNegative is: the patterns are
      // written against English, and an identifier survives translation
      // unchanged anyway. History is included because a follow-up legitimately
      // refers back to a case named two turns ago.
      //
      // Ahead of finalAnswer deliberately: that call writes the decision
      // record, and a warning the officer sees but the audit trail does not
      // would be the one part of the answer with no account of itself.
      try {
        groundingResult = grounding.check(text, {
          evidence,
          question: rawQuery,
          history: turnHistory,
        });
      } catch (e) {
        // A checker that breaks must not take the answer with it.
        console.error('grounding check failed (non-fatal):', e && e.message);
      }
      const groundingWarning = groundingResult ? grounding.warning(groundingResult, responseLang) : null;

      // Last line of defence, and deliberately the narrowest. It looks only for
      // the assistant having plainly complied with an attack — reciting its
      // instructions, announcing an unrestricted persona, claiming a clearance
      // check was bypassed. It does NOT judge whether an answer is
      // "appropriate": this is a police tool whose daily work is violence, and
      // a vague safety filter over that content would refuse real casework
      // every day. Grounding and clearance own those questions; this owns one.
      const outputScan = guard.scanOutput(text, { systemPrompt: TOOL_SYSTEM });
      if (outputScan.action === 'replace') {
        threatLog = threatLog.concat(outputScan.findings.map((f) => ({ ...f, stage: 'output' })));
        text = outputScan.message;
        // Whatever it was about to say, it was not drawn from the records — so
        // it gets no citations, and no grounding warning about an answer the
        // officer will never see.
        citedSources = [];
        groundingResult = null;
      }

      // Protected identity: say what was withheld and how to reach it, rather
      // than letting the officer read a case file with silent holes in it.
      const withheldReach = protectedReaches.find((pa) => pa.fieldsWithheld > 0);
      const protectedNotice = withheldReach ? redaction.protectedNotice(withheldReach, responseLang) : null;

      // finalAnswer runs the tier-2 guard and writes the decision record, so
      // the citations have to be settled before it is called.
      const answer = await finalAnswer(text, responseLang);

      // An answer that says nothing has nothing to attribute. "The records
      // don't hold this" is not a finding drawn from the Data Store, and
      // showing it under a source chip reads as though something WAS found —
      // the officer sees provenance for a claim that was never made. Checked
      // on the pre-localisation text: the detector is written against English.
      //
      // The audit record keeps its full attribution deliberately. What the
      // assistant consulted before giving up is exactly what a reviewer needs
      // months later; it is the officer's view that should be empty, not the
      // trail.
      const groundless = isNegative(text);
      const shownSources = groundless ? [] : citedSources;

      const sent = json(res, 200, {
        response_id: responseId,
        badge_id: badgeId(),
        answer,
        sources: shownSources,
        ...(groundingWarning
          ? { grounding: { warning: groundingWarning, ...groundingResult } }
          : {}),
        ...(protectedNotice
          ? {
            protected_access: {
              notice: protectedNotice,
              // False when the officer's clearance is the blocker — no reason
              // they can type will change that, and offering the box would be
              // a dead end dressed as a remedy.
              can_unlock: !!withheldReach.cleared,
              reason_given: withheldReach.reason,
            },
          }
          : {}),
        detected_lang: lid.lang,
        // What the answer is in, not what was asked for — see finalAnswer.
        response_lang: deliveredLang || responseLang,
        ...(deliveredLang && deliveredLang !== responseLang
          ? { localisation: 'unavailable' }
          : {}),
        // Worth telling the officer, not just the audit trail. A file that
        // contains an instruction aimed at an AI assistant is itself a finding:
        // somebody prepared that document expecting it to be read by a system
        // like this one. The content was still read — fenced, as data — so this
        // is intelligence about the document, not an apology for refusing it.
        ...(attachmentThreat
          ? {
            attachment_warning: {
              notice: i18n.t('attachment.injection', responseLang),
              detail: guard.summarise(attachmentThreat),
            },
          }
          : {}),
        ...payload,
        metrics: {
          pipeline_route: pipelineRoute(payload.source, citedSources),
          latency_ms: Date.now() - startedAt,
        },
      });
      // Deliberately after the answer is on the wire: consolidation costs a
      // model call, and no officer should wait on the assistant tidying its
      // own memory. If the container is frozen before it finishes, nothing is
      // lost — the session pointer's cursor makes the work resumable, so the
      // next threshold crossing or the session-end call picks up where this
      // left off.
      consolidateLater();
      return sent;
    };

    // ── Prompt-exfiltration refusal ──────────────────────────────────────
    //
    // The one input class with no innocent reading: asking for the assistant's
    // own configuration rather than anything in the case records. Refused here,
    // before any model or retrieval call, so it costs nothing and cannot be
    // talked past downstream.
    //
    // Routed through respondWith rather than returned directly, so a refusal is
    // audited, localised and cited exactly like any other answer. A refusal
    // that leaves no trace is the one an attacker would most like to be able to
    // make repeatedly.
    if (inputScan.action === 'refuse') {
      // The refusal is fixed text, so it is served from the string table rather
      // than being generated in English and translated on the way out. An
      // officer who asked in Kannada and is being turned down deserves the
      // reason in Kannada — that is the exchange where a foreign-language
      // sentence reads most like the system malfunctioning.
      return await respondWith(i18n.t('guard.refusal', responseLang) || inputScan.message, {
        source: 'guardrail',
        refused: 'prompt-exfiltration',
      }, []);
    }

    // ── Memory write-back ────────────────────────────────────────────────
    // On the single exit, so no lane can answer without the exchange being
    // remembered. Entirely best-effort: losing a memory write must never cost
    // the officer their answer.
    let bufferedTurns = 0;
    const rememberTurn = async (answerText) => {
      if (!sessionId || !clearanceApp) return;
      const turns = [
        { role: 'user', text: rawQuery, ts: startedAt },
        { role: 'assistant', text: answerText, ts: Date.now() },
      ];
      try {
        const buffered = ((memBuffer && memBuffer.turns) || []).concat(turns);
        bufferedTurns = buffered.length;
        await memory.writeBuffer(clearanceApp, sessionId, badgeId(), {
          turns: buffered,
          scratchpad: {
            last_route: routeDecision ? routeDecision.route : null,
            last_response_id: responseId,
          },
        });
        const badge = badgeId();
        if (!badge) return; // an unidentified caller gets no durable memory
        await memory.appendTurns(clearanceApp, sessionId, badge, turns);
        if (!(memBuffer && memBuffer.resumed)) {
          await memory.noteSession(clearanceApp, badge, sessionId, { started_at: startedAt });
        }
        // A memory write is a write about the officer, so it is auditable in
        // its own right — a distinct event, batched into the same trail write
        // as the answer it accompanied.
        memoryAudit.push({
          action: 'memory-write',
          feature: 'Assistant',
          path: '/assistant',
          detail:
            `session=${sessionId} badge=${badge} type=short-term+session-log ` +
            `turns=${turns.length} buffered=${buffered.length}` +
            (memRecall ? ` recall=${memRecall.origin}` : ''),
        });
      } catch (e) {
        console.error('memory write failed (non-fatal):', e && e.message);
      }
    };

    // Fold the working buffer into durable facts once it has grown past the
    // window. Idempotent and cursor-based, so running it twice is harmless.
    const consolidateLater = () => {
      const badge = badgeId();
      if (!sessionId || !badge || !clearanceApp) return;
      if (bufferedTurns < memory.CONSOLIDATE_AFTER_TURNS) return;
      runConsolidation(req, clearanceApp, clearanceBucket, sessionId, badge, callerUser)
        .catch((e) => console.error('consolidation failed (non-fatal):', e && e.message));
    };

    // ── Slash commands ───────────────────────────────────────────────────
    // Resolved before anything else: a command is an explicit instruction, so
    // it should never be re-interpreted by the router.
    // ── Attached images ──────────────────────────────────────────────────
    // Digests arrive already parsed (the client pre-parses on attach), so the
    // assistant reasons over the page's text and contents as ordinary
    // context. Re-filtered here rather than trusted: the digest travelled
    // through the browser, and a prompt is the one place unauthorised text
    // must never reach.
    const digests = Array.isArray(body.vision) ? body.vision.slice(0, 4) : [];
    let visionContext = '';
    if (digests.length) {
      const clearance = await resolveCaller();
      visionContext = digests
        .map((d) => {
          const safe = { ...d };
          if (safe.text) {
            const f = redaction.filterText(safe.text, clearance);
            safe.text = f.text;
            if (f.redactions.length) {
              redactionLog = redactionLog.concat(
                f.redactions.map((r) => ({ ...r, stage: 'pre-retrieval', source: 'vision' }))
              );
            }
          }
          return vision.digestToPrompt(safe);
        })
        .join('\n\n');
    }

    // ── Attached documents ───────────────────────────────────────────────
    // Read in the browser (only the text is sent, never the file) and filtered
    // here rather than trusted: the text travelled through the client, and a
    // prompt is the one place unauthorised content must never reach.
    const attached = (Array.isArray(body.attachments) ? body.attachments : [])
      .slice(0, 4)
      .filter((a) => a && typeof a.text === 'string' && a.text.trim())
      .map((a) => ({
        name: String(a.name || 'attached file').slice(0, 160),
        kind: String(a.kind || 'text').slice(0, 20),
        note: String(a.note || '').slice(0, 80),
        text: a.text.slice(0, 6000),
        tables: Array.isArray(a.tables) ? a.tables.slice(0, 2) : [],
      }));
    let docContext = '';
    if (attached.length) {
      const clearance = await resolveCaller();
      docContext = attached
        .map((a) => {
          const f = redaction.filterText(a.text, clearance);
          a.text = f.text;
          if (f.redactions.length) {
            redactionLog = redactionLog.concat(
              f.redactions.map((r) => ({ ...r, stage: 'pre-retrieval', source: 'attachment' }))
            );
          }
          const head = `Attached file: ${a.name} (${a.kind}${a.note ? `, ${a.note}` : ''})`;
          const tables = (a.tables || [])
            .map((t) => {
              const cols = (t.columns || []).join(' | ');
              const rows = (t.rows || []).slice(0, 20).map((r) => (r || []).join(' | ')).join('\n');
              return `Table ${t.title || ''}\n${cols}\n${rows}`.trim();
            })
            .join('\n\n');
          return [head, a.text, tables].filter(Boolean).join('\n');
        })
        .join('\n\n');
    }

    // One context for everything hanging off this message, so a question about
    // "this file" reads the same whether the officer attached a photograph or
    // a spreadsheet.
    // Everything hanging off this message came from a file, not from the
    // officer, so it is fenced before it can reach the model: an attachment or
    // a photographed page is precisely where an instruction aimed at the
    // assistant would arrive, and text concatenated into a prompt otherwise
    // carries no provenance at all. Flagged rather than refused — the officer
    // asked about this document, and declining to read a file because it
    // contains a suspicious sentence is its own denial of service.
    const rawAttachedContext = [visionContext, docContext].filter(Boolean).join('\n\n');
    let attachedContext = '';
    let attachmentThreat = null;
    if (rawAttachedContext) {
      const w = guard.wrapUntrusted(rawAttachedContext, 'a file the officer attached to this message');
      attachedContext = w.text;
      if (w.suspicious) {
        attachmentThreat = w.findings;
        threatLog = threatLog.concat(w.findings.map((f) => ({ ...f, stage: 'attachment' })));
      }
    }

    const slash = parseSlash(rawQuery);
    if (slash) {
      slashName = slash.name;
      const slashApp = catalystSDK.initialize(req);
      const slashBucket = slashApp.stratus().bucket(CONV_BUCKET);
      const { role: slashRole, caller: slashCaller } = await myRole(slashApp, slashBucket);
      const allowed = SLASH_ROLES[slash.name];
      if (allowed && (!slashCaller || !allowed.includes(slashRole))) {
        return await respondWith(
          `The /${slash.name} command isn't available for your role.`,
          { components: [], source: 'command' }
        );
      }

      // Compliance: who ran what, against which argument, and when.
      if (SLASH_SENSITIVE.has(slash.name)) {
        await storeAuditEvents(req, slashApp, slashBucket, [{
          action: `command:/${slash.name}`, feature: 'Assistant', path: '/assistant',
          detail: slash.arg ? slash.arg.slice(0, 200) : '(no argument)',
        }], slashCaller);
      }

      if (slash.name === 'help') {
        const lines = SLASH_HELP.map(([c, d]) => `- \`${c}\` — ${d}`).join('\n');
        return await respondWith(`**Available commands**\n\n${lines}`, {
          components: [], source: 'command',
        });
      }

      // No vehicle registry is connected to Sentinel. Saying so is the honest
      // answer; inventing an ownership record would be far worse than none.
      if (slash.name === 'vehicle') {
        return await respondWith(
          `Sentinel has no vehicle registry connected, so \`/vehicle\` cannot look up ownership for **${slash.arg}**.\n\n` +
            'The case records do hold vehicle details inside FIR brief facts where an officer recorded them — ' +
            `try asking "which FIRs mention ${slash.arg}" to search that text instead.`,
          { components: [], source: 'command' }
        );
      }

      // Missing-person cases are not a structured registry either; they live in
      // digitised paper and drafted reports, which is where this searches.
      if (slash.name === 'missing') {
        const hits = await searchDigitised(slashBucket, `missing person ${slash.arg}`, 5);
        const answer = hits.length
          ? `**Missing-person records matching “${slash.arg}”**\n\n` +
            hits.map((h, i) => `${i + 1}. **${h.title}** (${h.docType}) — ${h.excerpt.slice(0, 180).trim()}…`).join('\n')
          : `No missing-person record matching “${slash.arg}” was found.\n\n` +
            'Sentinel holds no structured missing-person registry — this searches digitised paper records, ' +
            'so a case only appears here once its file has been scanned into Records.';
        return await respondWith(
          answer,
          { components: [], source: 'command' },
          [attribution.fromDigitised(hits)]
        );
      }
    }

    const commandQuery = slash ? slashToQuery(slash.name, slash.arg) : null;
    const query = commandQuery
      || (responseLang === 'en' ? rawQuery : await normaliseToEnglish(rawQuery, responseLang));

    // A message that reads like an instruction override is answered, not
    // refused — an officer quoting a hostile document is doing their job, and
    // blocking them stops real work while stopping no attacker, who would
    // simply rephrase. What changes is that the model is told, before it reads
    // the message, that its instructions do not change and that this is a
    // question about data. Applied at the tool-loop call site below, where the
    // context-resolved text that actually reaches the model is assembled.

    // Conversation memory from the client: `history` is the short-term window
    // (recent turns, verbatim); `summary` is the long-term digest of older
    // turns. Both feed Groq (expansion + fallback), never the RAG query itself.
    //
    // The client's copy is the fallback, not the source of truth — the server
    // buffer below replaces it whenever the session is still live, so the
    // assistant's memory does not depend on what a browser chose to send.
    const clientHistory = (Array.isArray(body.history) ? body.history : [])
      .filter(
        (m) =>
          m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
      )
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
    let history = clientHistory;
    const summary = typeof body.summary === 'string' ? body.summary.slice(0, 2000) : '';
    let longTermContext = '';

    // Per Catalyst docs: when no documents are passed, RAG searches ALL active
    // knowledge-base documents. So we only scope the search when explicitly
    // asked to (request body or RAG_DOCUMENT_IDS) — new uploads just work.
    let documents =
      body.documents ||
      (process.env.RAG_DOCUMENT_IDS
        ? process.env.RAG_DOCUMENT_IDS.split(',').map((s) => s.trim()).filter(Boolean)
        : []);
    // Recent-FIRs-in-a-place questions are answered from the FIR knowledge-base
    // document — scope retrieval to it so the FIR records are always the context
    // (unless the caller already scoped the search explicitly).
    if (!documents.length && isRecentFirQuery(query)) documents = [FIR_DOC_ID];
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

    // ── Assembled memory context ─────────────────────────────────────────
    // Read before the router runs, so short-term buffer, long-term facts and
    // (only when the question asks for it) semantic recall reach every lane
    // below identically. Memory is per-officer: an unidentified caller and a
    // request with no session id both get nothing rather than someone else's.
    if (sessionId) {
      await resolveCaller();
      const badge = badgeId();
      try {
        memBuffer = await memory.readBuffer(clearanceApp, sessionId, badge);
        if (badge) {
          memFacts = await memory.readFacts(clearanceApp, badge);
          // Recall is a tool, not a step: reaching for past conversations on
          // every turn would spend a retrieval call to answer "how many FIRs
          // in Hubballi", which has nothing to do with what was said before.
          if (memory.wantsRecall(query)) {
            memRecall = await memory.recall(clearanceApp, badge, query, {
              facts: memFacts,
              // Scoped to this officer's own KB documents. An unscoped search
              // would read every officer's memory, which is the single thing
              // this feature must never do.
              ragSearch: async (q, docs) => pickAnswer((await callRag(q, docs, 12_000)).data || {}),
            });
          }
        }
      } catch (e) {
        console.error('memory read failed (non-fatal):', e && e.message);
      }
      const assembled = memory.assemble({ buffer: memBuffer, facts: memFacts, recalled: memRecall });
      // A live buffer is more trustworthy than the client's copy; an expired
      // one is not resurrected behind the officer's back.
      if (assembled.history.length) history = assembled.history;
      // What the officer is remembered for rides along as a system turn at the
      // head of the history, which is what every Groq lane already spreads —
      // so chat, guide, the attachment reader and the final fallback all see
      // it without any of them knowing memory exists.
      if (assembled.longTerm) {
        // Recalled memory is prose the officer once saw, not prose they are
        // cleared to see now — roles change, cases get sealed. It goes through
        // the same pre-retrieval filter as every other retrieved text.
        const f = redaction.filterText(assembled.longTerm, await resolveCaller());
        longTermContext = f.text;
        if (f.redactions.length) {
          redactionLog = redactionLog.concat(
            f.redactions.map((r) => ({ ...r, stage: 'pre-retrieval', source: 'memory' }))
          );
        }
        // Long-term memory is the one injection vector that PERSISTS, and it
        // lands in the system role — the position a model trusts most.
        //
        // The chain is real: a poisoned attachment is fenced on the way in and
        // is not obeyed, but the assistant's answer still describes it, that
        // answer enters the turn buffer, and consolidation asks a model to
        // extract durable "facts" from the transcript. A sentence crafted to
        // read like a fact about the officer can survive that summarising step
        // and come back, sessions later, as a system instruction — with the
        // original document long gone and nothing on screen to explain it.
        //
        // So this is the one place the response is to DISCARD rather than
        // fence. Everywhere else the officer asked to read the thing and
        // refusing would be its own denial of service; here it is background
        // context they never requested, so dropping it costs a little recall
        // and removes the only path by which an injection outlives the request
        // that carried it.
        const memScan = guard.scanUntrusted(longTermContext);
        if (memScan.length) {
          threatLog = threatLog.concat(memScan.map((x) => ({ ...x, stage: 'memory-recall' })));
          console.warn('memory recall discarded — injection markers:', guard.summarise(memScan));
          longTermContext = '';
        }
        if (longTermContext) {
          // Fenced even when clean. It is machine-written prose derived from
          // older conversations, not a system instruction someone authored.
          history = [{
            role: 'system',
            content: guard.fence(longTermContext, 'notes remembered from this officer\u2019s earlier sessions'),
          }].concat(history);
        }
      }
    }
    // History is final here — the server buffer and recalled memory have both
    // had their say. Mirrored for the grounding check, which runs from a
    // closure defined above this line.
    turnHistory = history;

    // Expand the question into a self-contained one for better retrieval,
    // using conversation context to resolve pronouns and references
    // (best-effort — the raw query is used if Groq is absent or slow).
    // Expansion exists ONLY to resolve conversational references ("it", "that
    // gang") into a standalone question. Without history there is nothing to
    // resolve — the raw question is always more faithful than a rewrite (small
    // models invent filters/years, which poisons ZCQL generation downstream).
    const contextBits = [];
    if (longTermContext) contextBits.push(longTermContext);
    if (summary) contextBits.push('Earlier conversation topics: ' + summary);
    const spokenTurns = history.filter((m) => m.role !== 'system');
    if (spokenTurns.length) {
      contextBits.push(
        'Recent conversation:\n' + spokenTurns.map((m) => `${m.role}: ${m.content}`).join('\n')
      );
    }
    const expanded = contextBits.length
      ? await callLLM(
          [
            { role: 'system', content: EXPAND_PROMPT },
            { role: 'user', content: contextBits.join('\n\n') + '\n\nQuestion: ' + query },
          ],
          // Fast model: keeps follow-up questions off the big model's day cap.
          { maxTokens: 160, temperature: 0.2, timeoutMs: 6_000, model: GROQ_MODEL_FAST }
        )
      : null;
    const searchQuery = (expanded || '').trim() || query;

    // ── Attached-image answers ───────────────────────────────────────────
    // An attachment usually means "read this for me", so the digest answers
    // the question directly. The exception is a query that ALSO carries a
    // record or aggregate signal ("does this FIR match anything on file?") —
    // that genuinely needs the data store, so the digest is carried down as
    // extra context and normal routing runs instead.
    if (attachedContext) {
      evidence.add(attachedContext);
      const alsoNeedsRecords = deterministicRoute(query);
      if (!alsoNeedsRecords) {
        const seen = await callLLM(
          [
            { role: 'system', content: VISION_SYSTEM },
            ...history,
            { role: 'user', content: `${attachedContext}\n\nQuestion: ${query || 'What does this document say?'}` },
          ],
          { maxTokens: 700, temperature: 0.2, timeoutMs: 20_000 }
        );
        if (seen && seen.trim()) {
          const v = extractAgui(seen);
          return await respondWith(v.text || seen.trim(), {
            components: v.components,
            source: attached.length ? 'attachment' : 'vision',
            route: { route: 'ATTACHMENT', confidence: 1, decided_by: 'attachment' },
          }, [attribution.fromVision(digests), attribution.fromAttachments(attached)]);
        }
        // Groq unavailable — fall through so the officer still gets an answer.
      }
    }

    // ── Router (Groq decides one word) — the assistant's decision point:
    //   CHAT  → casual chat, answered directly by Groq llama.
    //   GUIDE → question about the platform, answered by Groq from the feature map.
    //   ZCQL  → relational question, answered from the Data Store via text2zcql.
    //   RAG   → everything else, answered from the knowledge base.
    // Fallback chain so the assistant always answers: text2zcql failure →
    // RAG; RAG failure or non-answer → Groq llama (the final fallback).
    let zcqlDebug; // populated when the ZCQL path was tried but abandoned
    if (process.env.GROQ_API_KEY) {
      // CHAT must be judged on the user's ORIGINAL wording — expansion can
      // rewrite a bare "thanks!" into a restated data question.
      // A structurally unmistakable query is routed without a model call.
      const forced = deterministicRoute(query);
      const scored = forced || parseRouteReply(await callLLM(
        [
          { role: 'system', content: zcql.ROUTER_PROMPT +
            '\n\nReply ONLY as JSON: {"route":"CHAT|GUIDE|ZCQL|RAG|BOTH","confidence":0.0-1.0}. ' +
            'Use BOTH when the question needs written procedure AND specific record data. ' +
            'Set confidence below 0.5 when the intent is genuinely unclear.' },
          {
            role: 'user',
            content:
              searchQuery === query
                ? query
                : `Original message: ${query}\n(With context resolved: ${searchQuery})`,
          },
        ],
        { maxTokens: 40, temperature: 0, timeoutMs: 5_000, model: GROQ_MODEL_FAST }
      ));
      // An unclear route falls back to RAG: the knowledge base is the broadest
      // source, so a wrong guess there degrades to a weaker answer rather than
      // to a confidently wrong one from a narrow source.
      const lowConfidence = !!scored && scored.confidence < ROUTE_CONFIDENCE_FLOOR;
      const route = !scored ? null : lowConfidence ? 'RAG' : scored.route;
      routeDecision = {
        route: route || 'RAG',
        confidence: scored ? scored.confidence : 0,
        decided_by: forced ? 'override' : scored ? 'classifier' : 'default',
        why: forced ? forced.why : lowConfidence ? 'below confidence floor' : undefined,
      };
      const routed = route; // existing branches below match on this

      // Multi-lookup questions. Deliberately placed first among the lanes and
      // deliberately allowed to fall through: if the loop cannot run — no key,
      // no answer, budget spent — the question drops into the single-lane path
      // it would have taken before this route existed, so the worst case is
      // the behaviour we already had.
      if (routed === 'TOOLS') {
        await resolveCaller();
        const looped = await runToolLoop({
          // The framing notice rides with the question when the turn looked
          // like an override attempt, so the model reads "this is a question
          // about data" before it reads the message itself.
          query: inputScan.action === 'frame'
            ? `${guard.INPUT_FRAME_NOTICE}\n\n${searchQuery}`
            : searchQuery,
          history,
          app: clearanceApp,
          role: callerRole,
          req,
          bucket: clearanceBucket,
          access,
        });
        if (looped) {
          validatorChecks.push(`tools:${looped.used.join(',')}|iterations=${looped.iterations}`);
          if (looped.toolThreats && looped.toolThreats.length) {
            threatLog = threatLog.concat(looped.toolThreats.map((f) => ({ ...f, stage: 'retrieved' })));
          }
          protectedReaches.push(...(looped.protectedAccess || []));
          const cites = [];
          for (const set of looped.rowSets) {
            evidence.add(set.rows, (set.rows || []).length);
            cites.push(attribution.fromZcql({
              query: set.query,
              tables: zcql.tablesInQuery(set.query),
              rows: set.rows,
            }));
          }
          if (looped.scanHits.length) {
            evidence.add(looped.scanHits);
            cites.push(attribution.fromDigitised(looped.scanHits));
          }
          if (looped.usedKnowledgeBase) cites.push(attribution.knowledgeBaseFallback());
          const v = extractAgui(looped.text);
          return await respondWith(v.text || looped.text, {
            components: v.components,
            source: 'tools',
            route: routeDecision,
            expandedQuery: searchQuery === query ? undefined : searchQuery,
          }, cites);
        }
      }

      if (routed && /chat/i.test(routed)) {
        const chat = await callLLM(
          [{ role: 'system', content: CHAT_SYSTEM }, ...history, { role: 'user', content: query }],
          { maxTokens: 220, temperature: 0.6, timeoutMs: 12_000 }
        );
        if (chat && chat.trim()) {
          return await respondWith(chat.trim(), { components: [], source: 'chat' });
        }
        // Groq unavailable mid-request — fall through to the RAG path below.
      }
      if (routed && /guide/i.test(routed)) {
        const guide = await callLLM(
          [{ role: 'system', content: GUIDE_SYSTEM }, ...history, { role: 'user', content: query }],
          { maxTokens: 420, temperature: 0.3, timeoutMs: 12_000 }
        );
        if (guide && guide.trim()) {
          const g = extractAgui(guide);
          return await respondWith(g.text || guide.trim(), {
            components: g.components,
            source: 'guide',
          });
        }
        // Groq unavailable mid-request — fall through to the RAG path below.
      }
      // Mixed intent: the procedure half and the record half are independent
      // lookups, so RAG starts NOW and runs while ZCQL is still generating and
      // executing its query. Merged at the end; a fan-out that ran the two
      // sequentially would double the latency for no benefit.
      if (routed === 'BOTH') {
        fanoutRag = callRag(searchQuery, documents, 20_000).catch(() => null);
      }
      if (routed && /zcql|both/i.test(routed)) {
        try {
          const app = catalystSDK.initialize(req);
          let q = null;
          let rollup = null;
          let topN = null;
          let lastErr = null;
          let rows = null;
          for (let attempt = 0; attempt < 2 && !rows; attempt++) {
            const gen = await callLLM(
              [
                { role: 'system', content: zcql.ZCQL_SYSTEM },
                { role: 'user', content: zcql.buildUserPrompt(searchQuery, q, lastErr) },
              ],
              // ZCQL generation runs on the fast model: it's a structured task it
              // handles well, and it keeps data questions off the big model's
              // small per-day token budget (which its fallbacks can exhaust).
              { maxTokens: 350, temperature: 0, timeoutMs: 10_000, model: GROQ_MODEL_FAST }
            );
            const s = zcql.parsePlan(gen);
            if (s.checks) validatorChecks = validatorChecks.concat(s.checks);
            if (!s.ok) {
              validatorChecks.push(`rejected:${s.error}`);
              lastErr = s.error; q = gen && String(gen).slice(0, 400); continue;
            }
            if (s.unanswerable) {
              // On a BOTH fan-out the record half coming up empty must not
              // sink the whole answer — the procedure half was a separate
              // question and is already in flight. Take it and stop treating
              // this as a data query.
              if (fanoutRag) {
                const rr = await fanoutRag;
                const sop = rr && rr.ok ? extractAgui(pickAnswer(rr.data)) : null;
                if (sop && sop.text && !isNegative(sop.text)) {
                  return await respondWith(sop.text.trim(), {
                    components: sop.components,
                    source: 'rag',
                    route: routeDecision,
                    expandedQuery: searchQuery === query ? undefined : searchQuery,
                  }, [ragCitations(rr)]);
                }
                // The knowledge base had nothing either (it currently holds no
                // procedural documents). Abandon the data path entirely rather
                // than answering a procedure question with "the database does
                // not store workflow" — that is a true statement and a useless
                // answer. Falling through reaches the general fallback, which
                // can at least state the statutory procedure.
                rows = null;
                zcqlDebug = { attempted: true, abandoned: 'both-fanout: no record half' };
                break;
              }
              // The database genuinely can't answer this — say so honestly
              // rather than running an unrelated query or guessing.
              // The Data Store can't answer — but the scanned paper records
              // might, so consult them before giving up.
              const fromScans = await answerFromDigitised(req, query, await resolveCaller());
              if (fromScans) {
                evidence.add(fromScans.hits);
                return await respondWith(fromScans.text, {
                  components: [],
                  source: 'digitised-records',
                  expandedQuery: searchQuery === query ? undefined : searchQuery,
                }, [attribution.fromDigitised(fromScans.hits)]);
              }
              // No citation. This used to name the Data Store on the reasoning
              // that "where we looked is part of the answer" — but a source
              // chip beside "the records don't hold this" invites the officer
              // to open it expecting a record, and there is none. Where we
              // looked still goes to the audit trail.
              return await respondWith(s.unanswerable, {
                components: [],
                source: 'zcql',
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
            // Pre-retrieval clearance filter. This runs BEFORE the rows are
            // rendered into components or serialised into the prose prompt, so
            // a caller without clearance never has the data in their context
            // and the model is never shown what it must not repeat.
            {
              const filtered = redaction.filterRows(flat, await resolveCaller(), access);
              flat = filtered.rows;
              redactionLog = redactionLog.concat(
                filtered.redactions.map((r) => ({ ...r, stage: 'pre-retrieval', source: 'zcql' }))
              );
              if (filtered.protectedAccess) protectedReaches.push(filtered.protectedAccess);
            }
            // The FULL filtered set, not the 20-60 rows the prose prompt gets:
            // an identifier the model saw is supported, and feeding fewer rows
            // here than it was shown would invent phantom inventions.
            evidence.add(flat, flat.length);
            const components = zcql.rowsToComponents(flat, undefined, responseLang);
            // When the result is a multi-row list, the table carries the data;
            // the prose must be a SHORT summary and never re-list the rows.
            const isList = flat.length > 3;
            const prose = await callLLM(
              [
                {
                  role: 'system',
                  content:
                    "DOMAIN: 'FIR', 'FIRs', 'firs', 'fir' ALWAYS mean First Information " +
                    'Report — a registered police case. Never interpret them as trees, ' +
                    "people, or anything else. 'cases' and 'crimes' also mean these records.\n" +
                    (isList
                      ? 'You are Sentinel Assistant. The query returned ' +
                        `${flat.length} records, already shown to the user as a TABLE. ` +
                        'Write ONE short summary sentence only — a count and/or the single ' +
                        'top item. NEVER list, enumerate, or repeat the individual records, ' +
                        'and never output a markdown table. Invent nothing.'
                      : 'You are Sentinel Assistant. Answer the analyst question from the ' +
                        'query result rows (JSON) in 1-2 sentences, stating numbers plainly. ' +
                        'If rows are empty, say no matching records were found. Invent nothing.'),
                },
                {
                  role: 'user',
                  content:
                    (attachedContext ? attachedContext + '\n\n' : '') +
                    `Question: ${query}\n\nRows (${flat.length}` +
                    `${flat.length === 200 ? ', truncated' : ''}):\n` +
                    // Record text is not the officer's text either. BriefFacts
                    // is free prose typed at a station, and on a live CCTNS it
                    // is partly dictated by the person making the complaint —
                    // so an FIR is something an attacker can get words into by
                    // walking in and filing one. Cheap to fence, and it closes
                    // the last unfenced route from stored data to the model.
                    guard.fence(
                      JSON.stringify(flat.slice(0, isList ? 20 : 60)),
                      'rows returned from the case database'
                    ),
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
            // Merge the procedure half of a mixed-intent question. The records
            // lead (they are what was asked about specifically) and the SOP
            // follows as context, each clearly attributed to its source.
            if (fanoutRag) {
              const rr = await fanoutRag;
              const sop = rr && rr.ok ? extractAgui(pickAnswer(rr.data)) : null;
              if (sop && sop.text && !isNegative(sop.text)) {
                answerText += `\n\n**Procedure**\n\n${sop.text.trim()}`;
                ragCited = ragCitations(rr);
              }
            }
            // A negative prose ("no matching records", "does not answer...")
            // with a rendered data table is a contradiction — the rows didn't
            // answer the question, so don't show them.
            const showComponents = flat.length > 0 && !isNegative(answerText);
            return await respondWith(answerText, {
              components: showComponents ? components : [],
              source: 'zcql',
              route: routeDecision,
              zcql: q,
              expandedQuery: searchQuery === query ? undefined : searchQuery,
            }, [
              // The rows cited are the ones the caller was actually shown —
              // already through the pre-retrieval clearance filter above.
              attribution.fromZcql({ query: q, tables: zcql.tablesInQuery(q), rows: flat }),
              ragCited,
              // An attached file that fed this answer is cited too: the
              // officer should not have to remember what they hung off the
              // question to know what it was answered from.
              attribution.fromAttachments(attached),
            ]);
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

    // Pass 1: retrieval-augmented answer from the knowledge base. A hard RAG
    // failure (network / 5xx / timeout) is NOT fatal — it leaves the answer
    // empty so the Groq fallback below still responds. Groq llama is the final
    // safety net whenever both text2zcql and RAG come up short.
    let first;
    try {
      // The station's own uploads are searched CONCURRENTLY with the knowledge
      // base, not after it. They used to be a last resort, which meant a
      // question about a document an officer had just uploaded could be
      // answered from general material instead — the scan or recording sitting
      // right there was never consulted because the knowledge base had said
      // something plausible. Running both costs nothing in wall-clock time.
      digitisedPromise = answerFromDigitised(req, query, await resolveCaller()).catch(() => null);
      // If the route was BOTH and the ZCQL half fell through, the fan-out
      // call is already in flight — reuse it rather than paying for it twice.
      first = (fanoutRag && (await fanoutRag)) || (await callRag(searchQuery, documents, 30_000));
    } catch (e) {
      first = { ok: false, status: 502, data: { error: (e && e.message) || String(e) } };
    }
    const extracted = first.ok ? extractAgui(pickAnswer(first.data)) : { text: '', components: [] };
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

    // Before falling back to general knowledge, consult the digitised paper
    // records — scanned documents are station-specific and will never be in
    // the knowledge base, so they are often the only place an answer exists.
    let digitisedHits = null;
    if (isNegative(text)) {
      const fromScans = digitisedPromise
        ? await digitisedPromise
        : await answerFromDigitised(req, query, await resolveCaller());
      if (fromScans) {
        evidence.add(fromScans.hits);
        text = fromScans.text;
        components = [];
        source = 'digitised-records';
        digitisedHits = fromScans.hits;
      }
    }

    // Fallback LLM: only when neither the knowledge base nor the scans answer.
    if (isNegative(text)) {
      const fb = await callLLM(
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
      const viaGroq = await callLLM(
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
    let answer = stripDuplicatedLists(text, components);
    // If every stage (text2zcql, RAG, Groq) came up empty, respond gracefully
    // instead of returning a blank message.
    if (!answer.trim() && !components.length) {
      answer = 'I couldn’t find an answer for that. Try rephrasing, or ask about FIR data, crime statistics, law and procedure, or any part of the platform.';
      source = 'fallback';
    }

    // Attribution for whichever lane ended up answering. A general-knowledge
    // fallback cites nothing, because it has nothing to cite — and a sources
    // row there would imply a provenance that does not exist.
    const citations =
      source === 'digitised-records'
        ? [attribution.fromDigitised(digitisedHits || [])]
        : source === 'rag'
          ? [ragCitations(first)]
          : [];

    // Audit trail keeps the query as the officer typed it AND the English it
    // was normalised to, so a later reviewer can see what was actually searched.
    if (responseLang !== 'en') {
      try {
        const auditApp = catalystSDK.initialize(req);
        const auditBucket = auditApp.stratus().bucket(CONV_BUCKET);
        await storeAuditEvents(req, auditApp, auditBucket, [{
          action: 'assistant-query', feature: 'Assistant', path: '/assistant',
          detail: `[${lid.lang}→en] ${rawQuery.slice(0, 160)} :: ${query.slice(0, 160)}`,
        }], await requestUser(auditApp));
      } catch (e) {
        console.error('language audit failed (non-fatal):', e && e.message);
      }
    }

    return await respondWith(answer, {
      components,
      source,
      command: slashName || undefined,
      lid_confidence: Number(lid.confidence.toFixed(2)),
      normalized_query: responseLang === 'en' ? undefined : query,
      expandedQuery: searchQuery === query ? undefined : searchQuery,
      zcqlDebug,
      raw: first.data,
    }, citations);
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};

// Test seam. The audit-integrity helpers do real Stratus I/O — listing a day,
// writing a seal, advancing the head pointer — and that wiring is exactly
// where a mistake would go unnoticed, because the module they call is itself
// well covered. Exposed on the handler (a function object; Catalyst neither
// sees nor cares about extra properties) so integrity.test.js can drive them
// against a fake bucket. Nothing here is reachable over HTTP.
module.exports._audit = { loadAuditDay, sealDayIfClosed, sealKey, SEAL_HEAD_KEY, AUDIT_PREFIX, utcDay };
