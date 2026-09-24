// Chatbot storage + helpers. Conversations live in localStorage so sessions and
// history survive reloads. 
import { currentLang } from '../i18n';
import { capturePageContext } from './pageContext';

const STORAGE_KEY = 'sentinel-chat-sessions';
const MODEL_STORAGE_KEY = 'sentinel-chat-model';
const VOICE_LANG_STORAGE_KEY = 'sentinel.voiceLang';

// Which language the mic listens for — independent of the platform's display
// language (an officer whose console is in English still needs to dictate a
// Hindi/Kannada sentence without switching the whole UI), and shared between
// the full assistant page and the floating widget so the choice only has to
// be made once per device. Forcing speech through the wrong language's
// recogniser doesn't error, it just phonetically mangles the words into
// Latin letters ("han bhai mera naam...") — neither English nor Devanagari.
export const VOICE_LANG_OPTIONS = [
  { key: 'en', label: 'English' },
  { key: 'hi', label: 'हिंदी' },
  { key: 'kn', label: 'ಕನ್ನಡ' },
];
const VOICE_LANG_KEYS = VOICE_LANG_OPTIONS.map((o) => o.key);

export function loadVoiceLang() {
  try {
    const v = localStorage.getItem(VOICE_LANG_STORAGE_KEY);
    if (VOICE_LANG_KEYS.includes(v)) return v;
  } catch { /* private browsing / storage disabled */ }
  return currentLang();
}

export function saveVoiceLang(lang) {
  try { localStorage.setItem(VOICE_LANG_STORAGE_KEY, lang); } catch { /* private browsing / storage disabled */ }
}

// The assistant's model switcher. 
// `short` is the composer trigger's label on a phone. The provider marks in
// ModelLogos are shape-only — enough to tell three providers apart NEXT TO
// their names, but the Groq one is a circle with two hands, and on its own
// beside a mic and a send arrow it reads as a clock. So the phone keeps a
// name and drops the logo, not the other way round. Menu rows are unaffected
// and always show the full label.
export const MODEL_OPTIONS = [
  { key: 'groq', label: 'GPT-OSS-120B', short: 'GPT-OSS', desc: 'Groq · fast, default' },
  { key: 'glm', label: 'GLM-4.7-Flash', short: 'GLM-4.7', desc: 'Zoho Catalyst-hosted' },
  { key: 'claude', label: 'Claude Opus 5', short: 'Opus 5', desc: 'Anthropic' },
];
const MODEL_KEYS = MODEL_OPTIONS.map((m) => m.key);
const DEFAULT_MODEL = 'groq';

export function loadModel() {
  try {
    const v = localStorage.getItem(MODEL_STORAGE_KEY);
    return MODEL_KEYS.includes(v) ? v : DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

export function saveModel(model) {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, model);
  } catch {
  }
}

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function sanitizeMessages(msgs) {
  if (!Array.isArray(msgs)) return [];
  const out = [];
  for (const m of msgs) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const prev = out[out.length - 1];
    if (m.role === 'user' && prev && prev.role === 'user' && prev.content === m.content) continue;
    out.push(m);
  }
  while (out.length && out[out.length - 1].role === 'user') out.pop();
  return out;
}

export function sanitizeSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : [])
    .map((s) => ({ ...s, messages: sanitizeMessages(s.messages) }))
    .filter((s) => s.messages.length > 0);
}

export function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return sanitizeSessions(Array.isArray(arr) ? arr : []);
  } catch {
    return [];
  }
}

export function saveSessions(sessions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

// Derive a short, meaningful conversation title from the first user message.
export function makeTitle(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  const words = clean.split(' ');
  const short = words.slice(0, 7).join(' ');
  const title = short.length < clean.length ? `${short}…` : short;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export const newSession = () => ({
  id: uid(),
  title: 'New chat',
  createdAt: Date.now(),
  messages: [],
});

// Merge one conversation into the shared local session store (used by the
// floating widget so its chats appear in the main assistant's history).
export function upsertLocalSession(session) {
  const all = loadSessions();
  const idx = all.findIndex((s) => s.id === session.id);
  const merged = { ...(idx >= 0 ? all[idx] : {}), ...session, updatedAt: Date.now() };
  saveSessions(idx >= 0 ? all.map((s) => (s.id === session.id ? merged : s)) : [merged, ...all]);
}

const slimSource = (s) => {
  if (!s || typeof s !== 'object') return s;
  const out = { ...s };
  if (out.records && out.records.length) {
    delete out.records;
    out.records_trimmed = true;
  }
  delete out.query;
  if (Array.isArray(out.passages) && out.passages.length) {
    out.passages = out.passages.slice(0, 1).map((p) => ({
      ...p,
      excerpt: String(p.excerpt || '').slice(0, 300),
    }));
  }
  if (Array.isArray(out.matched_record_ids)) out.matched_record_ids = out.matched_record_ids.slice(0, 12);
  return out;
};

const slimMsg = (m) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  ...(m.components && m.components.length ? { components: m.components } : {}),
  ...(m.sources && m.sources.length
    ? { sources: m.sources.map(slimSource), source: m.source }
    : {}),
  ...(m.files && m.files.length ? { files: m.files } : {}),
});

export async function loadSessionsRemote(email) {
  if (!email) return null;
  try {
    const res = await fetch('/server/rag/conversations/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.conversations)) return null;
    return data.conversations
      .map((c) => ({ ...c, messages: sanitizeMessages(c.messages) }))
      .filter((c) => c.messages.length > 0);
  } catch {
    return null;
  }
}
export async function saveSessionRemote(session, email, extra = {}) {
  if (!email || !session || !session.messages?.length) return null;
  try {
    const res = await fetch('/server/rag/conversations/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        id: session.id,
        title: session.title,
        messages: session.messages.map(slimMsg),
        ...(typeof session.starred === 'boolean' ? { starred: session.starred } : {}),
        ...extra,
      }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Last-chance save when the tab hides (refresh/close/navigate away) — the
// debounced fetch save doesn't survive unload, a beacon does.
export function saveSessionBeacon(session, email) {
  if (!email || !session?.messages?.length || !navigator.sendBeacon) return false;
  const body = JSON.stringify({
    email,
    id: session.id,
    title: session.title,
    messages: session.messages.map(slimMsg),
    ...(typeof session.starred === 'boolean' ? { starred: session.starred } : {}),
  });
  return navigator.sendBeacon(
    '/server/rag/conversations/save',
    new Blob([body], { type: 'application/json' })
  );
}

// Tell the backend a conversation has ended, so it can fold the session into
// the officer's long-term memory. 
export function consolidateMemory(sessionId) {
  if (!sessionId) return false;
  const body = JSON.stringify({ session_id: sessionId });
  if (navigator.sendBeacon) {
    return navigator.sendBeacon(
      '/server/rag/memory/consolidate',
      new Blob([body], { type: 'application/json' })
    );
  }
  fetch('/server/rag/memory/consolidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
  return true;
}

export async function deleteSessionRemote(id, email) {
  if (!email || !id) return;
  try {
    await fetch('/server/rag/conversations/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, id }),
    });
  } catch {
    /* best-effort */
  }
}

async function toWav(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    ctx.close();
  }
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);

  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

// Transcribe an audio Blob/File via the Zia audio-to-text model (proxied by
// the same server-side function that fronts RAG). Returns the transcript text;
// throws with a readable message on failure.
export async function transcribeAudio(input, language = 'en') {
  let blob = input;
  let filename = 'recording.wav';
  try {
    blob = await toWav(input);
  } catch {
    // Undecodable in this browser — send the original and let the model try.
    filename = input.name || 'recording.webm';
  }

  const qs = new URLSearchParams({
    mimetype: blob.type || 'audio/wav',
    filename,
    language,
  }).toString();
  let res;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(`/server/rag/transcribe?${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
      });
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  if (!res) throw new Error(`transcription failed — ${lastErr?.message || 'network error'}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason =
      (data.detail && (data.detail.message || (data.detail.details && data.detail.details.reason))) ||
      data.error ||
      `HTTP ${res.status}`;
    throw new Error(`transcription failed — ${reason}`);
  }
  const text = String(data.text || '').replace(/^[.\s]+$/, '');
  if (!text) throw new Error('no speech detected in the audio');
  return text;
}
export async function generateReply(
  history, vision = [], attachments = [], sessionId = '', accessReason = '', model = ''
) {
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const query = (lastUser?.content || '').trim();
  if (!query) return { text: 'Ask me a question to get started.', components: [] };

  // Conversation memory: the last few turns verbatim (short-term) plus a
  // digest of older user questions (long-term). The backend feeds these to
  // the LLM for question rephrasing and fallback answers.
  const msgs = history.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && (m.content || '').trim()
  );
  const prior = msgs.slice(0, msgs.lastIndexOf(lastUser));
  const shortTerm = prior
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
  const summary = prior
    .slice(0, -6)
    .filter((m) => m.role === 'user')
    .slice(-10)
    .map((m) => m.content.replace(/\s+/g, ' ').slice(0, 140))
    .join(' | ')
    .slice(0, 1500);

  try {
    const res = await fetch('/server/rag/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        session_id: sessionId,
        ...(accessReason ? { access_reason: accessReason } : {}),
        ...(model ? { model } : {}),
        history: shortTerm,
        summary,
        preferred_lang: currentLang(),
        page_context: capturePageContext(),
        vision,
        attachments: attachments.map((a) => ({
          name: a.name,
          kind: a.kind,
          text: a.text,
          tables: a.tables,
          note: a.note,
        })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data.error || `HTTP ${res.status}`;
      return { text: `⚠️ The assistant backend returned an error: ${detail}`, components: [] };
    }
    const components = Array.isArray(data.components) ? data.components : [];
    const sources = Array.isArray(data.sources) ? data.sources.filter(Boolean) : [];
    const text =
      (typeof data.answer === 'string' && data.answer.trim()) ||
      (components.length
        ? ''
        : 'The RAG service responded but returned no answer text. ' +
          '(It may need documents configured, or the response field differs.)');
    return {
      text, components, sources, source: data.source,
      grounding: data.grounding || null,
      confidence: data.confidence || null,
      protectedAccess: data.protected_access || null,
      attachmentWarning: data.attachment_warning || null,
    };
  } catch (e) {
    return {
      text:
        '⚠️ Couldn’t reach the assistant backend. Once the RAG proxy function is ' +
        'deployed and its credentials are set, answers will appear here.\n\n' +
        `(${e.message || e})`,
      components: [],
    };
  }
}

// Username lookup (Sherlock via Apify) — start + poll, not the normal
// generateReply() pipeline. A run genuinely takes 60-110+ seconds (see
// functions/rag/sherlock.js for why), so this polls the status endpoint on
// an interval rather than making one request and waiting on it.
const SHERLOCK_POLL_MS = 4000;
const SHERLOCK_MAX_POLLS = 45; // ~3 minutes before giving up client-side

export async function runSherlockLookup(username, onProgress) {
  const post = async (path, body) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  };

  try {
    const start = await post('/server/rag/sherlock/start', { username });
    if (!start.ok || start.data.error) {
      return {
        text: `⚠️ Could not start the username lookup: ${start.data.error || `HTTP ${start.status}`}`,
        components: [],
      };
    }
    const { runId } = start.data;

    for (let i = 0; i < SHERLOCK_MAX_POLLS; i++) {
      if (onProgress) {
        onProgress(i === 0
          ? 'Running Sherlock — this can take a minute or more…'
          : `Still running Sherlock — ~${Math.round((i * SHERLOCK_POLL_MS) / 1000)}s so far…`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, SHERLOCK_POLL_MS); });
      // eslint-disable-next-line no-await-in-loop
      const poll = await post('/server/rag/sherlock/status', { runId });
      if (!poll.ok || poll.data.error) {
        return {
          text: `⚠️ The username lookup failed: ${poll.data.error || `HTTP ${poll.status}`}`,
          components: [],
        };
      }
      if (poll.data.status === 'failed') {
        return { text: `⚠️ ${poll.data.error}`, components: [] };
      }
      if (poll.data.status === 'done') {
        const links = Array.isArray(poll.data.links) ? poll.data.links : [];
        const CAP = 60;
        const shown = links.slice(0, CAP);
        const text =
          `**Sherlock username lookup — "${poll.data.username}"**\n\n` +
          (shown.length
            ? `Found ${links.length} possible match${links.length === 1 ? '' : 'es'}` +
              (links.length > CAP ? ` (showing the first ${CAP})` : '') + ':\n\n' +
              shown.map((l) => `- ${l}`).join('\n')
            : 'No accounts found for this username.') +
          `\n\n${poll.data.sovereignty}\n\n` +
          'These are possible matches by username only, not verified identity — each link must be checked before being treated as a lead.';
        return { text, components: [], sources: [] };
      }
    }
    return {
      text: '⚠️ The username lookup is taking longer than expected. It may still finish on Apify\'s side — try again in a few minutes.',
      components: [],
    };
  } catch (e) {
    return { text: `⚠️ Couldn't run the username lookup: ${e.message || e}`, components: [] };
  }
}
