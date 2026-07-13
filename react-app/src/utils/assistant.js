// Chatbot storage + helpers. Conversations live in localStorage so sessions and
// history survive reloads. The reply function is deliberately pluggable — swap
// `generateReply` for a call to a Catalyst serverless function that proxies a
// real model (e.g. Claude) when you're ready.

const STORAGE_KEY = 'sentinel-chat-sessions';

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Clean a message list so a refresh mid-answer never leaves orphaned or
// duplicated questions: collapse adjacent identical user messages, then drop
// any trailing user message(s) that never received an assistant reply.
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

// Sanitize every session and drop any that end up empty.
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

// ── Remote persistence (Catalyst Data Store, via the rag function) ──────────
// Conversations are scoped by the signed-in user's email so they follow the
// officer across devices and survive cache clears. localStorage stays as an
// instant cache; these sync it with the server.

// Strip transient/bulky fields before persisting a message.
const slimMsg = (m) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  ...(m.components && m.components.length ? { components: m.components } : {}),
  ...(m.sources && m.sources.length ? { sources: m.sources, source: m.source } : {}),
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
    // Same cleanup for server copies (a refresh mid-answer may have synced a
    // dangling question).
    return data.conversations
      .map((c) => ({ ...c, messages: sanitizeMessages(c.messages) }))
      .filter((c) => c.messages.length > 0);
  } catch {
    return null;
  }
}

// Persist one conversation; returns { title, starred } (title may be
// AI-generated). `starred` is sent only when provided (star toggle / rename).
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

// Re-encode any decodable audio (webm/opus recordings, mp3 files, …) into
// 16 kHz mono PCM WAV — the format the Zia transcription model reliably
// accepts. Uses the browser's own decoder, so whatever MediaRecorder produced
// is guaranteed decodable here.
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
  const base64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('could not read audio'));
    fr.readAsDataURL(blob);
  });
  const res = await fetch('/server/rag/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio: base64,
      mimetype: blob.type || 'audio/wav',
      filename,
      language,
    }),
  });
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

// Ask the RAG proxy function (server-side, same origin) for an answer. Returns
// { text, components } — components are AG-UI-style typed specs (bar-chart,
// pie-chart, table, cards) rendered by AguiRenderer. Falls back to an
// explanatory message if the backend isn't reachable/configured yet.
export async function generateReply(history) {
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
      body: JSON.stringify({ query, history: shortTerm, summary }),
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
    return { text, components, sources, source: data.source };
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
