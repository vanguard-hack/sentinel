import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Plus, MessageSquare, Trash2,
  Paperclip, Mic, ArrowUp, X, Shield, FileText, PanelLeft,
  Copy, Check, ThumbsUp, ThumbsDown, RotateCcw, MoreVertical,
  Star, Pencil, FileDown, CheckSquare,
} from 'lucide-react';
import {
  loadSessions, saveSessions, makeTitle, newSession, generateReply, uid,
  transcribeAudio, loadSessionsRemote, saveSessionRemote, saveSessionBeacon, deleteSessionRemote,
} from '../utils/assistant';
import AguiRenderer from '../components/AguiRenderer';
import RichText from '../components/RichText';
import Avatar from '../components/Avatar';
import Thinking from '../components/Thinking';
import TopBar from '../components/TopBar';
import i18n from '../i18n';
import { useAuth } from '../context/AuthContext';
import { exportConversationPdf } from '../utils/reportPdf';

// Short, domain-relevant prompts shown on an empty conversation.
const SUGGESTIONS = [
  'Recent FIRs in Bengaluru City',
  'Which districts have the most crime?',
  'List known habitual offenders',
  'Unsolved cases by police station',
];

// Voice input records real audio via MediaRecorder and transcribes it with the
// Zia audio-to-text model (English / Hindi / Kannada, follows the UI language).
const canRecord =
  typeof window !== 'undefined' &&
  typeof window.MediaRecorder !== 'undefined' &&
  navigator.mediaDevices &&
  typeof navigator.mediaDevices.getUserMedia === 'function';

export default function Assistant() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const email = user?.email_id || null;

  // Opening from the floating widget's "expand" passes the conversation to focus.
  const incomingId = location.state?.conversationId || null;
  const [sessions, setSessions] = useState(() => loadSessions());
  const [activeId, setActiveId] = useState(() => incomingId || loadSessions()[0]?.id || null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]); // { id, name, size, type, url? }
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [menuId, setMenuId] = useState(null); // open kebab menu
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelId, setConfirmDelId] = useState(null); // single-delete modal
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const menuRef = useRef(null);

  // Close the kebab menu on outside click.
  useEffect(() => {
    if (menuId == null) return undefined;
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuId(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuId]);

  // Up/Down history navigation through this session's past questions.
  const histRef = useRef({ idx: null, draft: '' });

  const textareaRef = useRef(null);
  const fileRef = useRef(null);
  const threadRef = useRef(null);
  const recognitionRef = useRef(null);

  const active = sessions.find((s) => s.id === activeId) || null;
  const messages = useMemo(() => active?.messages || [], [active]);

  useEffect(() => { saveSessions(sessions); }, [sessions]);

  // When navigated here from the widget, focus that conversation and clear the
  // one-shot navigation state so a later refresh doesn't re-open it.
  useEffect(() => {
    if (incomingId) {
      setActiveId(incomingId);
      navigate('.', { replace: true, state: null });
    }
  }, [incomingId, navigate]);

  // On sign-in, load the officer's stored conversations from Stratus. The
  // server is authoritative (so history is intact after logout/login and a
  // different user never sees the previous user's cached chats). Any brand-new
  // local session not yet on the server is merged in so an in-flight chat
  // isn't dropped.
  const remoteLoaded = useRef(false);
  useEffect(() => {
    if (!email || remoteLoaded.current) return;
    remoteLoaded.current = true;
    let cancelled = false;
    (async () => {
      const remote = await loadSessionsRemote(email);
      if (cancelled || !remote) return; // offline → keep local cache
      setSessions((local) => {
        // Union by id, keeping the FRESHEST copy of each conversation. The
        // server may hold an older snapshot (the debounced save can miss the
        // last exchange before a refresh) — blindly preferring it rewound
        // conversations, so the copy with more messages / a newer timestamp
        // wins instead.
        const byId = new Map(remote.map((r) => [r.id, r]));
        local.forEach((s) => {
          if (!s.messages?.length) return;
          const r = byId.get(s.id);
          const localFresher =
            !r ||
            s.messages.length > (r.messages?.length || 0) ||
            (s.messages.length === (r.messages?.length || 0) &&
              (s.updatedAt || s.createdAt || 0) > (r.updatedAt || r.createdAt || 0));
          if (localFresher) byId.set(s.id, s);
        });
        return [...byId.values()].sort(
          (a, b) =>
            (b.starred ? 1 : 0) - (a.starred ? 1 : 0) ||
            (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
        );
      });
    })();
    return () => { cancelled = true; };
  }, [email]);

  // Sessions the user manually renamed — their titles must never be
  // overwritten by the server's auto-title.
  const renamedRef = useRef(new Set());

  // Debounced push of a changed session to the server; adopts the server's
  // AI-generated title (unless the user renamed the conversation). Sessions
  // stay in dirtyRef until a save is confirmed so the tab-hide beacon below
  // can rescue anything the debounce hasn't sent yet.
  const saveTimers = useRef({});
  const dirtyRef = useRef(new Map()); // id → latest unsaved session
  const pushSession = useCallback((session) => {
    if (!email || !session?.messages?.length) return;
    const renamed = renamedRef.current.has(session.id);
    dirtyRef.current.set(session.id, session);
    clearTimeout(saveTimers.current[session.id]);
    saveTimers.current[session.id] = setTimeout(async () => {
      const out = await saveSessionRemote(session, email, renamed ? {} : { autotitle: true });
      if (out) dirtyRef.current.delete(session.id);
      if (out?.title && !renamed) {
        setSessions((prev) =>
          prev.map((s) => (s.id === session.id ? { ...s, title: out.title } : s))
        );
      }
    }, 700);
  }, [email]);

  // Refresh/close/navigate-away kills in-flight debounced saves — flush any
  // unsaved conversation as a beacon so the last exchange survives reload.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      dirtyRef.current.forEach((s) => {
        if (saveSessionBeacon(s, email)) dirtyRef.current.delete(s.id);
      });
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
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

  // Only allow starting a new chat when the current one has content — prevents
  // stacking multiple empty "New chat" conversations.
  const onBlankNewChat = !activeId || messages.length === 0;
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
  // The server copy is deleted too — otherwise the reload union restores the
  // old messages from the server snapshot and the reset silently undoes.
  const resetConversation = useCallback(() => {
    if (!activeId) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId
          ? { ...s, title: 'New chat', messages: [], updatedAt: Date.now() }
          : s
      )
    );
    dirtyRef.current.delete(activeId);
    deleteSessionRemote(activeId, email);
    setInput('');
    setAttachments([]);
    histRef.current = { idx: null, draft: '' };
    textareaRef.current?.focus();
  }, [activeId, email]);

  const deleteSession = (id) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (id === activeId) setActiveId(null);
    deleteSessionRemote(id, email);
  };

  // Toggle star (favourite) — starred conversations sort to the top.
  const toggleStar = (id) => {
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, starred: !s.starred } : s));
      const s = next.find((x) => x.id === id);
      if (s && email && s.messages.length) saveSessionRemote(s, email, { starred: s.starred });
      return next;
    });
    setMenuId(null);
  };

  const commitRename = (id, title) => {
    const clean = (title || '').trim();
    setRenamingId(null);
    if (!clean) return;
    renamedRef.current.add(id); // protect this title from auto-titling
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: clean } : s)));
    const s = sessions.find((x) => x.id === id);
    if (s && email && s.messages.length) saveSessionRemote({ ...s, title: clean }, email);
  };

  // Export one conversation's full transcript to PDF (captures the thread DOM).
  const exportSession = async (id) => {
    setMenuId(null);
    if (id !== activeId) { setActiveId(id); await new Promise((r) => setTimeout(r, 80)); }
    if (!threadRef.current) return;
    const title = sessions.find((s) => s.id === id)?.title || 'Conversation';
    setExporting(true);
    try {
      await exportConversationPdf(threadRef.current, title);
    } catch { /* ignore */ } finally {
      setExporting(false);
    }
  };

  const bulkDelete = () => {
    selected.forEach((id) => deleteSessionRemote(id, email));
    setSessions((prev) => prev.filter((s) => !selected.has(s.id)));
    if (selected.has(activeId)) setActiveId(null);
    setSelected(new Set());
    setSelectMode(false);
    setConfirmBulk(false);
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

    // Resolve the target session id UP FRONT (never derive it inside the state
    // updater — the updater runs during React's flush, after setActiveId, so
    // reading it back there yields null and the view snaps to the greeting).
    // Title stays 'New chat' so the server assigns an AI-generated one.
    const created = activeId ? null : newSession();
    const sessionId = activeId || created.id;
    setSessions((prev) => {
      const base = created ? [created, ...prev] : prev;
      return base.map((s) =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, userMsg], updatedAt: Date.now() }
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
      const fullMessages = [...history, botMsg];
      // Give a brand-new conversation an instant, meaningful title from the
      // first question (upgraded to the AI title once the server responds).
      const current = sessions.find((s) => s.id === sessionId);
      const isFirst = !current || current.messages.length === 0;
      const interimTitle =
        isFirst && !renamedRef.current.has(sessionId) ? makeTitle(text) : current?.title || 'New chat';
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                title: renamedRef.current.has(s.id) ? s.title : interimTitle,
                messages: fullMessages,
                updatedAt: Date.now(),
              }
            : s
        )
      );
      // Persist AFTER the state update (never call side effects inside an
      // updater — a throw there unmounts the whole page).
      pushSession({ id: sessionId, title: interimTitle, messages: fullMessages });
    } catch (err) {
      const botMsg = {
        id: uid(),
        role: 'assistant',
        content: `Sorry — something went wrong: ${err.message || err}`,
        ts: Date.now(),
      };
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, messages: [...s.messages, botMsg], updatedAt: Date.now() }
            : s
        )
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
      <TopBar title="Assistant" subtitle="Ask about crime data">
        <button
          className="nav-icon-btn as-sidebar-toggle"
          onClick={() => setSidebarOpen((o) => !o)}
          aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? 'Hide conversations' : 'Show conversations'}
        >
          <PanelLeft size={18} />
        </button>
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
      </TopBar>

      <div className="as-body">
        {/* ── Sessions sidebar ── */}
        <aside className={`as-sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
          <button
            className="as-new-btn"
            onClick={startNewChat}
            disabled={onBlankNewChat}
            title={onBlankNewChat ? 'You already have a new chat open' : 'Start a new chat'}
          >
            <Plus size={16} /> New chat
          </button>
          {selectMode && (
            <div className="as-select-bar">
              <span>{selected.size} selected</span>
              <div>
                <button
                  className="as-select-del"
                  disabled={!selected.size}
                  onClick={() => setConfirmBulk(true)}
                >
                  <Trash2 size={13} /> Delete
                </button>
                <button
                  className="as-select-cancel"
                  onClick={() => { setSelectMode(false); setSelected(new Set()); }}
                >
                  Done
                </button>
              </div>
            </div>
          )}
          <div className="as-session-list">
            {sessions.length === 0 && <p className="as-empty-hint">No conversations yet.</p>}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`as-session ${s.id === activeId ? 'active' : ''}`}
                onClick={() => {
                  if (selectMode) {
                    setSelected((prev) => {
                      const n = new Set(prev);
                      n.has(s.id) ? n.delete(s.id) : n.add(s.id);
                      return n;
                    });
                  } else if (renamingId !== s.id) {
                    selectSession(s.id);
                  }
                }}
                title={s.title}
              >
                {selectMode ? (
                  <span className={`as-session-check ${selected.has(s.id) ? 'on' : ''}`}>
                    {selected.has(s.id) && <Check size={12} />}
                  </span>
                ) : s.starred ? (
                  <Star size={14} className="as-session-icon starred" fill="currentColor" />
                ) : (
                  <MessageSquare size={15} className="as-session-icon" />
                )}

                {renamingId === s.id ? (
                  <input
                    className="as-rename-input"
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(s.id, renameValue);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={() => commitRename(s.id, renameValue)}
                  />
                ) : (
                  <span className="as-session-title">{s.title}</span>
                )}

                {!selectMode && renamingId !== s.id && (
                  <div className="as-session-menu-wrap" ref={menuId === s.id ? menuRef : null}>
                    <button
                      className="as-session-kebab"
                      onClick={(e) => { e.stopPropagation(); setMenuId(menuId === s.id ? null : s.id); }}
                      title="Options"
                    >
                      <MoreVertical size={15} />
                    </button>
                    {menuId === s.id && (
                      <div className="as-conv-menu" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { setSelectMode(true); setSelected(new Set([s.id])); setMenuId(null); }}>
                          <CheckSquare size={15} /> Select
                        </button>
                        <button onClick={() => toggleStar(s.id)}>
                          <Star size={15} /> {s.starred ? 'Unstar' : 'Star'}
                        </button>
                        <button onClick={() => { setRenamingId(s.id); setRenameValue(s.title); setMenuId(null); }}>
                          <Pencil size={15} /> Rename
                        </button>
                        <button onClick={() => exportSession(s.id)}>
                          <FileDown size={15} /> Export PDF
                        </button>
                        <button className="as-conv-menu-del" onClick={() => { setConfirmDelId(s.id); setMenuId(null); }}>
                          <Trash2 size={15} /> Delete
                        </button>
                      </div>
                    )}
                  </div>
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
                <Shield size={40} strokeWidth={1.3} />
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
                      {m.role === 'user' ? <Avatar user={user} size={30} /> : <Shield size={16} />}
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
                    <div className="as-avatar"><Shield size={16} /></div>
                    <div className="as-msg-body">
                      <Thinking />
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

      {/* Delete confirmation modals */}
      {confirmDelId && (
        <div className="as-modal-overlay" onClick={() => setConfirmDelId(null)}>
          <div className="as-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete conversation?</h3>
            <p>
              "{sessions.find((s) => s.id === confirmDelId)?.title || 'This conversation'}" will be
              permanently deleted. This can't be undone.
            </p>
            <div className="as-modal-actions">
              <button className="as-modal-cancel" onClick={() => setConfirmDelId(null)}>Cancel</button>
              <button
                className="as-modal-delete"
                onClick={() => { deleteSession(confirmDelId); setConfirmDelId(null); }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmBulk && (
        <div className="as-modal-overlay" onClick={() => setConfirmBulk(false)}>
          <div className="as-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete {selected.size} conversation{selected.size === 1 ? '' : 's'}?</h3>
            <p>The selected conversations will be permanently deleted. This can't be undone.</p>
            <div className="as-modal-actions">
              <button className="as-modal-cancel" onClick={() => setConfirmBulk(false)}>Cancel</button>
              <button className="as-modal-delete" onClick={bulkDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
      {exporting && (
        <div className="as-modal-overlay">
          <div className="as-modal as-export-toast">
            <span className="btn-spinner" /> Exporting conversation to PDF…
          </div>
        </div>
      )}
    </div>
  );
}
