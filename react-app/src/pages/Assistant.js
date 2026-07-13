import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield, ArrowLeft, Sun, Moon, Plus, MessageSquare, Trash2,
  Paperclip, Mic, ArrowUp, X, Bot, FileText, PanelLeft,
  Copy, Check, ThumbsUp, ThumbsDown, RotateCcw,
} from 'lucide-react';
import {
  loadSessions, saveSessions, makeTitle, newSession, generateReply, uid,
  transcribeAudio, loadSessionsRemote, saveSessionRemote, deleteSessionRemote,
} from '../utils/assistant';
import AguiRenderer from '../components/AguiRenderer';
import RichText from '../components/RichText';
import Avatar from '../components/Avatar';
import i18n from '../i18n';
import { useAuth } from '../context/AuthContext';

// Short, domain-relevant prompts shown on an empty conversation.
const SUGGESTIONS = [
  'Recent FIRs in Bengaluru City',
  'Which districts have the most crime?',
  'List known habitual offenders',
  'Unsolved cases by police station',
];

function useTheme() {
  const [isDark, setIsDark] = useState(
    () => localStorage.getItem('sentinel-theme') === 'dark'
  );
  useEffect(() => {
    const theme = isDark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('sentinel-theme', theme);
  }, [isDark]);
  return [isDark, setIsDark];
}

// Voice input records real audio via MediaRecorder and transcribes it with the
// Zia audio-to-text model (English / Hindi / Kannada, follows the UI language).
const canRecord =
  typeof window !== 'undefined' &&
  typeof window.MediaRecorder !== 'undefined' &&
  navigator.mediaDevices &&
  typeof navigator.mediaDevices.getUserMedia === 'function';

export default function Assistant() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const email = user?.email_id || null;
  const [isDark, setIsDark] = useTheme();

  const [sessions, setSessions] = useState(() => loadSessions());
  const [activeId, setActiveId] = useState(() => loadSessions()[0]?.id || null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]); // { id, name, size, type, url? }
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [confirmDelId, setConfirmDelId] = useState(null);

  // Up/Down history navigation through this session's past questions.
  const histRef = useRef({ idx: null, draft: '' });

  const textareaRef = useRef(null);
  const fileRef = useRef(null);
  const threadRef = useRef(null);
  const recognitionRef = useRef(null);

  const active = sessions.find((s) => s.id === activeId) || null;
  const messages = useMemo(() => active?.messages || [], [active]);

  useEffect(() => { saveSessions(sessions); }, [sessions]);

  // On sign-in, pull the officer's stored conversations from the Data Store and
  // merge them over the local cache (server wins — it's the durable copy).
  useEffect(() => {
    if (!email) return;
    let cancelled = false;
    (async () => {
      const remote = await loadSessionsRemote(email);
      if (cancelled || !remote) return;
      setSessions((local) => {
        const byId = new Map(local.map((s) => [s.id, s]));
        remote.forEach((r) => byId.set(r.id, { ...byId.get(r.id), ...r }));
        return [...byId.values()].sort(
          (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
        );
      });
    })();
    return () => { cancelled = true; };
  }, [email]);

  // Debounced push of a changed session to the server; adopts the server's
  // AI-generated title when the local one is still the default.
  const saveTimers = useRef({});
  const pushSession = useCallback((session) => {
    if (!email || !session?.messages?.length) return;
    clearTimeout(saveTimers.current[session.id]);
    saveTimers.current[session.id] = setTimeout(async () => {
      const title = await saveSessionRemote(session, email);
      if (title && (session.title === 'New chat' || !session.title)) {
        setSessions((prev) =>
          prev.map((s) => (s.id === session.id ? { ...s, title } : s))
        );
      }
    }, 900);
  }, [email]);

  // Autoscroll the thread on new messages / typing.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // Auto-grow the composer.
  const growTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };
  useEffect(growTextarea, [input]);

  const startNewChat = useCallback(() => {
    setActiveId(null);
    setInput('');
    setAttachments([]);
    histRef.current = { idx: null, draft: '' };
    textareaRef.current?.focus();
  }, []);

  const selectSession = (id) => {
    setActiveId(id);
    setInput('');
    setAttachments([]);
    histRef.current = { idx: null, draft: '' };
  };

  // Wipe the active conversation's messages but keep the session itself.
  const resetConversation = useCallback(() => {
    if (!activeId) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId ? { ...s, title: 'New chat', messages: [] } : s
      )
    );
    setInput('');
    setAttachments([]);
    histRef.current = { idx: null, draft: '' };
    textareaRef.current?.focus();
  }, [activeId]);

  const deleteSession = (id, e) => {
    e.stopPropagation();
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (id === activeId) setActiveId(null);
    deleteSessionRemote(id, email);
  };

  const send = useCallback(async (override) => {
    const text = (typeof override === 'string' ? override : input).trim();
    if ((!text && attachments.length === 0) || sending) return;

    const userMsg = {
      id: uid(),
      role: 'user',
      content: text,
      files: attachments.map(({ name, size, type }) => ({ name, size, type })),
      ts: Date.now(),
    };

    // Resolve the target session (create one on the first message).
    let sessionId = activeId;
    setSessions((prev) => {
      let list = prev;
      if (!sessionId) {
        const s = newSession();
        sessionId = s.id;
        list = [s, ...prev];
      }
      return list.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              title: s.messages.length === 0 ? makeTitle(text) : s.title,
              messages: [...s.messages, userMsg],
            }
          : s
      );
    });
    setActiveId(sessionId);
    setInput('');
    setAttachments([]);
    histRef.current = { idx: null, draft: '' };
    setSending(true);

    try {
      const history = [...(sessions.find((s) => s.id === sessionId)?.messages || []), userMsg];
      const reply = await generateReply(history);
      const botMsg = {
        id: uid(),
        role: 'assistant',
        content: reply.text,
        components: reply.components,
        sources: reply.sources,
        source: reply.source,
        ts: Date.now(),
      };
      setSessions((prev) => {
        const next = prev.map((s) =>
          s.id === sessionId ? { ...s, messages: [...s.messages, botMsg] } : s
        );
        const done = next.find((s) => s.id === sessionId);
        if (done) pushSession(done); // persist the full exchange
        return next;
      });
    } catch (err) {
      const botMsg = {
        id: uid(),
        role: 'assistant',
        content: `Sorry — something went wrong: ${err.message || err}`,
        ts: Date.now(),
      };
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, messages: [...s.messages, botMsg] } : s))
      );
    } finally {
      setSending(false);
    }
  }, [input, attachments, sending, activeId, sessions, pushSession]);

  // Cycle previous/next questions with Up/Down (readline-style).
  const navigateHistory = (dir) => {
    const questions = messages.filter((m) => m.role === 'user').map((m) => m.content);
    if (!questions.length) return false;
    const h = histRef.current;
    if (dir === 'up') {
      if (h.idx === null) { h.draft = input; h.idx = questions.length - 1; }
      else h.idx = Math.max(0, h.idx - 1);
      setInput(questions[h.idx]);
      return true;
    }
    // down
    if (h.idx === null) return false;
    if (h.idx >= questions.length - 1) { h.idx = null; setInput(h.draft); return true; }
    h.idx += 1;
    setInput(questions[h.idx]);
    return true;
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    const el = e.target;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    if (e.key === 'ArrowUp' && (input === '' || atStart)) {
      if (navigateHistory('up')) e.preventDefault();
    } else if (e.key === 'ArrowDown' && histRef.current.idx !== null) {
      if (navigateHistory('down')) e.preventDefault();
    }
  };

  const onFiles = (e) => {
    const files = Array.from(e.target.files || []);
    // Audio files are transcribed straight into the composer instead of
    // being attached — the assistant works on text.
    files.filter((f) => f.type.startsWith('audio/')).forEach((f) => runTranscription(f));
    const picked = files
      .filter((f) => !f.type.startsWith('audio/'))
      .map((f) => ({
        id: uid(),
        name: f.name,
        size: f.size,
        type: f.type,
        url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
      }));
    setAttachments((prev) => [...prev, ...picked]);
    e.target.value = '';
  };

  const removeAttachment = (id) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));

  const copyMessage = (m) => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(m.content).then(() => {
      setCopiedId(m.id);
      setTimeout(() => setCopiedId((c) => (c === m.id ? null : c)), 1500);
    });
  };

  // Toggle thumbs-up / thumbs-down feedback on an assistant message.
  const setFeedback = (msgId, value) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId
          ? {
              ...s,
              messages: s.messages.map((m) =>
                m.id === msgId ? { ...m, feedback: m.feedback === value ? null : value } : m
              ),
            }
          : s
      )
    );
  };

  // Feed a finished audio blob/file through Zia and append the transcript to
  // the composer. Errors surface in the disclaimer line under the composer.
  const runTranscription = useCallback(async (blob) => {
    setTranscribing(true);
    setVoiceError(null);
    try {
      const text = await transcribeAudio(blob, i18n.resolvedLanguage || 'en');
      setInput((cur) => (cur ? cur.replace(/\s+$/, '') + ' ' + text : text));
      textareaRef.current?.focus();
    } catch (e) {
      setVoiceError(e.message || String(e));
    } finally {
      setTranscribing(false);
    }
  }, []);

  const toggleMic = async () => {
    if (!canRecord || transcribing) return;
    if (listening) {
      recognitionRef.current?.stop(); // triggers onstop → transcription
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setListening(false);
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size > 800) runTranscription(blob); // skip sub-second blips
      };
      recognitionRef.current = rec;
      setVoiceError(null);
      setListening(true);
      rec.start();
    } catch (e) {
      setVoiceError('Microphone unavailable: ' + (e.message || e));
      setListening(false);
    }
  };

  return (
    <div className="as-page">
      <header className="db-nav-bar">
        <button
          className="nav-icon-btn as-sidebar-toggle"
          onClick={() => setSidebarOpen((o) => !o)}
          aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? 'Hide conversations' : 'Show conversations'}
        >
          <PanelLeft size={18} />
        </button>
        <div className="db-nav-brand">
          <Shield size={20} strokeWidth={1.5} className="nav-brand-icon" />
          <span className="nav-brand-name">SENTINEL</span>
          <span className="nav-brand-rule" />
          <span className="nav-brand-sub">Assistant</span>
        </div>
        <button className="cf-back-btn" onClick={() => navigate('/dashboard')}>
          <ArrowLeft size={15} />
          <span>Dashboard</span>
        </button>
        <div className="db-nav-right">
          {messages.length > 0 && (
            <button
              className="nav-icon-btn"
              onClick={resetConversation}
              title="Reset conversation"
              aria-label="Reset conversation"
            >
              <RotateCcw size={17} />
            </button>
          )}
          <button
            className="nav-icon-btn"
            onClick={() => setIsDark((d) => !d)}
            title={isDark ? 'Light mode' : 'Dark mode'}
          >
            {isDark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
      </header>

      <div className="as-body">
        {/* ── Sessions sidebar ── */}
        <aside className={`as-sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
          <button className="as-new-btn" onClick={startNewChat}>
            <Plus size={16} /> New chat
          </button>
          <div className="as-session-list">
            {sessions.length === 0 && <p className="as-empty-hint">No conversations yet.</p>}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`as-session ${s.id === activeId ? 'active' : ''}`}
                onClick={() => selectSession(s.id)}
                title={s.title}
              >
                <MessageSquare size={15} className="as-session-icon" />
                <span className="as-session-title">{s.title}</span>
                {confirmDelId === s.id ? (
                  <span className="as-session-confirm" onClick={(e) => e.stopPropagation()}>
                    <span className="as-confirm-q">Delete?</span>
                    <button
                      className="as-confirm-yes"
                      onClick={(e) => { deleteSession(s.id, e); setConfirmDelId(null); }}
                      title="Confirm delete"
                    >
                      <Check size={14} />
                    </button>
                    <button
                      className="as-confirm-no"
                      onClick={(e) => { e.stopPropagation(); setConfirmDelId(null); }}
                      title="Cancel"
                    >
                      <X size={14} />
                    </button>
                  </span>
                ) : (
                  <button
                    className="as-session-del"
                    onClick={(e) => { e.stopPropagation(); setConfirmDelId(s.id); }}
                    title="Delete conversation"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </aside>

        {/* ── Conversation ── */}
        <main className="as-main">
          <div className="as-thread" ref={threadRef}>
            {messages.length === 0 && !sending ? (
              <div className="as-greeting">
                <Bot size={40} strokeWidth={1.3} />
                <h1>How can I help?</h1>
                <p>Ask a question, attach a file, or use the mic to speak.</p>
                <div className="as-suggestions">
                  {SUGGESTIONS.map((q) => (
                    <button key={q} className="as-suggestion" onClick={() => send(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="as-messages">
                {messages.map((m) => (
                  <div key={m.id} className={`as-msg as-msg-${m.role}`}>
                    <div className="as-avatar">
                      {m.role === 'user' ? <Avatar user={user} size={28} /> : <Bot size={16} />}
                    </div>
                    <div className="as-msg-body">
                      {m.files && m.files.length > 0 && (
                        <div className="as-msg-files">
                          {m.files.map((f, i) => (
                            <span className="as-file-chip" key={i}>
                              <FileText size={13} /> {f.name}
                            </span>
                          ))}
                        </div>
                      )}
                      {m.content && (
                        <div className="as-msg-text">
                          {m.role === 'assistant' ? <RichText text={m.content} /> : m.content}
                        </div>
                      )}
                      {m.role === 'assistant' && <AguiRenderer components={m.components} />}
                      {m.role === 'assistant' && Array.isArray(m.sources) && m.sources.length > 0 && (
                        <div className="as-msg-sources">
                          <FileText size={12} />
                          <span>
                            {m.source === 'fallback' ? '' : 'Sources: '}
                            {m.sources.join(' · ')}
                          </span>
                        </div>
                      )}
                      {m.role === 'assistant' && m.content && (
                        <div className="as-msg-actions">
                          <button onClick={() => copyMessage(m)} title="Copy" aria-label="Copy response">
                            {copiedId === m.id ? <Check size={15} /> : <Copy size={15} />}
                          </button>
                          <button
                            className={m.feedback === 'up' ? 'active up' : ''}
                            onClick={() => setFeedback(m.id, 'up')}
                            title="Good response"
                            aria-label="Good response"
                            aria-pressed={m.feedback === 'up'}
                          >
                            <ThumbsUp size={15} />
                          </button>
                          <button
                            className={m.feedback === 'down' ? 'active down' : ''}
                            onClick={() => setFeedback(m.id, 'down')}
                            title="Bad response"
                            aria-label="Bad response"
                            aria-pressed={m.feedback === 'down'}
                          >
                            <ThumbsDown size={15} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {sending && (
                  <div className="as-msg as-msg-assistant">
                    <div className="as-avatar"><Bot size={16} /></div>
                    <div className="as-msg-body">
                      <div className="as-typing"><span /><span /><span /></div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Composer ── */}
          <div className="as-composer-wrap">
            <div className="as-composer">
              {attachments.length > 0 && (
                <div className="as-attach-row">
                  {attachments.map((a) => (
                    <span className="as-attach-chip" key={a.id}>
                      {a.url ? (
                        <img src={a.url} alt="" className="as-attach-thumb" />
                      ) : (
                        <FileText size={13} />
                      )}
                      <span className="as-attach-name">{a.name}</span>
                      <button onClick={() => removeAttachment(a.id)} title="Remove">
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="as-composer-main">
                <button
                  className="as-comp-btn"
                  onClick={() => fileRef.current?.click()}
                  title="Attach files"
                >
                  <Paperclip size={18} />
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  onChange={onFiles}
                />
                <textarea
                  ref={textareaRef}
                  className="as-input"
                  rows={1}
                  placeholder="Message Sentinel…   (↑/↓ for history)"
                  value={input}
                  onChange={(e) => { setInput(e.target.value); histRef.current.idx = null; }}
                  onKeyDown={onKeyDown}
                />
                {canRecord && (
                  <button
                    className={`as-comp-btn ${listening ? 'listening' : ''} ${transcribing ? 'transcribing' : ''}`}
                    onClick={toggleMic}
                    disabled={transcribing}
                    title={
                      transcribing
                        ? 'Transcribing…'
                        : listening
                        ? 'Stop recording'
                        : 'Record voice (Zia transcription — English/Hindi/Kannada)'
                    }
                  >
                    <Mic size={18} />
                  </button>
                )}
                <button
                  className="as-send-btn"
                  onClick={send}
                  disabled={(!input.trim() && attachments.length === 0) || sending}
                  title="Send"
                >
                  <ArrowUp size={18} />
                </button>
              </div>
            </div>
            <p className={`as-disclaimer ${voiceError ? 'as-voice-error' : ''}`}>
              {voiceError
                ? `Voice input: ${voiceError}`
                : transcribing
                ? 'Transcribing audio with Zia…'
                : listening
                ? 'Recording — click the mic again to stop.'
                : 'Sentinel Assistant — answers come from the FIR Data Store and the knowledge base.'}
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
