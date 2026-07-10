// Chatbot storage + helpers. Conversations live in localStorage so sessions and
// history survive reloads. The reply function is deliberately pluggable — swap
// `generateReply` for a call to a Catalyst serverless function that proxies a
// real model (e.g. Claude) when you're ready.

const STORAGE_KEY = 'sentinel-chat-sessions';

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
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
