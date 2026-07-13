import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { MessageSquare, X, ArrowUp, Bot, Maximize2, RotateCcw, Mic } from 'lucide-react';
import {
  generateReply, uid, transcribeAudio, saveSessionRemote,
} from '../utils/assistant';
import { useAuth } from '../context/AuthContext';
import AguiRenderer from './AguiRenderer';
import RichText from './RichText';
import Thinking from './Thinking';
import i18n from '../i18n';

// Floating assistant: a bubble in the bottom-right that expands into a compact
// chat. Full parity with the assistant page — suggested questions, voice input
// (Zia STT), AG-UI charts, source attribution — and its conversation persists
// to the Data Store (scoped by user) so it shows up in history like any other.
// Hidden on /assistant itself.

const STORE_KEY = 'sentinel-widget-chat';

const SUGGESTIONS = [
  'How many FIRs were registered in 2024?',
  'Top 5 districts by number of cases',
  'What is a cognizable offence?',
  'Which crime head has the most heinous cases?',
];

const canRecord =
  typeof window !== 'undefined' &&
  typeof window.MediaRecorder !== 'undefined' &&
  navigator.mediaDevices &&
  typeof navigator.mediaDevices.getUserMedia === 'function';

const loadState = () => {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { id: s.id || uid(), messages: Array.isArray(s.messages) ? s.messages : [] };
  } catch {
    return { id: uid(), messages: [] };
  }
};

export default function ChatWidget() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const email = user?.email_id || null;

  const [open, setOpen] = useState(false);
  const [state, setState] = useState(loadState); // { id, messages }
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const threadRef = useRef(null);
  const inputRef = useRef(null);
  const recorderRef = useRef(null);

  const { id: convId, messages } = state;

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ id: convId, messages: messages.slice(-40) }));
    } catch { /* non-fatal */ }
  }, [convId, messages]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, open]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const persist = useCallback((msgs) => {
    if (email && msgs.length) {
      saveSessionRemote({ id: convId, title: 'New chat', messages: msgs }, email);
    }
  }, [email, convId]);

  const send = useCallback(async (override) => {
    const text = (typeof override === 'string' ? override : input).trim();
    if (!text || sending) return;
    const userMsg = { id: uid(), role: 'user', content: text };
    const history = [...messages, userMsg];
    setState((s) => ({ ...s, messages: history }));
    setInput('');
    setSending(true);
    try {
      const reply = await generateReply(history);
      const botMsg = {
        id: uid(),
        role: 'assistant',
        content: reply.text,
        components: reply.components,
        sources: reply.sources,
        source: reply.source,
      };
      const next = [...history, botMsg];
      setState((s) => ({ ...s, messages: next }));
      persist(next);
    } catch (e) {
      setState((s) => ({
        ...s,
        messages: [...history, { id: uid(), role: 'assistant', content: `Sorry — ${e.message || e}` }],
      }));
    } finally {
      setSending(false);
    }
  }, [input, sending, messages, persist]);

  const resetChat = () => setState({ id: uid(), messages: [] });

  const toggleMic = async () => {
    if (!canRecord || transcribing) return;
    if (listening) { recorderRef.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setListening(false);
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size < 800) return;
        setTranscribing(true);
        try {
          const text = await transcribeAudio(blob, i18n.resolvedLanguage || 'en');
          setInput((cur) => (cur ? cur.replace(/\s+$/, '') + ' ' + text : text));
          inputRef.current?.focus();
        } catch { /* surfaced by empty input */ } finally {
          setTranscribing(false);
        }
      };
      recorderRef.current = rec;
      setListening(true);
      rec.start();
    } catch {
      setListening(false);
    }
  };

  if (location.pathname.startsWith('/assistant')) return null;

  return (
    <>
      {open && (
        <div className="cw-panel" role="dialog" aria-label="Sentinel Assistant">
          <div className="cw-head">
            <div className="cw-head-title"><Bot size={16} /><span>Sentinel Assistant</span></div>
            <div className="cw-head-actions">
              <button onClick={resetChat} title="New conversation" disabled={!messages.length}>
                <RotateCcw size={14} />
              </button>
              <button onClick={() => navigate('/assistant')} title="Open full assistant">
                <Maximize2 size={14} />
              </button>
              <button onClick={() => setOpen(false)} title="Close"><X size={15} /></button>
            </div>
          </div>

          <div className="cw-thread" ref={threadRef}>
            {messages.length === 0 && !sending ? (
              <div className="cw-empty">
                <Bot size={26} strokeWidth={1.4} />
                <p>Ask about cases, districts, officers or procedure.</p>
                <div className="cw-suggestions">
                  {SUGGESTIONS.map((q) => (
                    <button key={q} className="cw-suggestion" onClick={() => send(q)}>{q}</button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`cw-msg cw-msg-${m.role}`}>
                  {m.role === 'assistant' ? (
                    <>
                      {m.content && <div className="cw-bubble"><RichText text={m.content} /></div>}
                      <AguiRenderer components={m.components} />
                      {Array.isArray(m.sources) && m.sources.length > 0 && (
                        <div className="cw-sources">
                          {m.source === 'fallback' ? '' : 'Sources: '}{m.sources.join(' · ')}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="cw-bubble">{m.content}</div>
                  )}
                </div>
              ))
            )}
            {sending && (
              <div className="cw-msg cw-msg-assistant">
                <div className="cw-bubble"><Thinking /></div>
              </div>
            )}
          </div>

          <div className="cw-composer">
            <input
              ref={inputRef}
              className="cw-input"
              placeholder={transcribing ? 'Transcribing…' : listening ? 'Listening…' : 'Ask Sentinel…'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
              disabled={transcribing}
            />
            {canRecord && (
              <button
                className={`cw-mic ${listening ? 'listening' : ''}`}
                onClick={toggleMic}
                disabled={transcribing}
                title={listening ? 'Stop recording' : 'Voice input (English/Hindi/Kannada)'}
              >
                <Mic size={16} />
              </button>
            )}
            <button className="cw-send" onClick={() => send()} disabled={!input.trim() || sending} aria-label="Send">
              <ArrowUp size={16} />
            </button>
          </div>
        </div>
      )}

      <button
        className={`cw-fab ${open ? 'open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Close assistant' : 'Ask Sentinel Assistant'}
        aria-label={open ? 'Close assistant' : 'Open assistant'}
      >
        {open ? <X size={22} /> : <MessageSquare size={22} />}
      </button>
    </>
  );
}
