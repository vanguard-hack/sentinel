import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { MessageSquare, X, ArrowUp, Bot, Maximize2, RotateCcw } from 'lucide-react';
import { generateReply, uid } from '../utils/assistant';
import AguiRenderer from './AguiRenderer';
import RichText from './RichText';

// Floating assistant: a bubble in the bottom-right of every page that expands
// into a compact chat panel. Same backend as the full /assistant page; its
// quick-chat thread persists separately in localStorage. Hidden on /assistant
// itself (the full page is already the assistant).

const STORE_KEY = 'sentinel-widget-chat';

const loadThread = () => {
  try {
    const arr = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
};

export default function ChatWidget() {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState(loadThread);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const threadRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-40)));
    } catch { /* non-fatal */ }
  }, [messages]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    const userMsg = { id: uid(), role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setSending(true);
    try {
      const reply = await generateReply(history);
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: 'assistant',
          content: reply.text,
          components: reply.components,
          sources: reply.sources,
          source: reply.source,
        },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: 'assistant', content: `Sorry — something went wrong: ${e.message || e}` },
      ]);
    } finally {
      setSending(false);
    }
  }, [input, sending, messages]);

  // The full assistant page has its own composer — no widget there.
  if (location.pathname.startsWith('/assistant')) return null;

  return (
    <>
      {open && (
        <div className="cw-panel" role="dialog" aria-label="Sentinel Assistant">
          <div className="cw-head">
            <div className="cw-head-title">
              <Bot size={16} />
              <span>Sentinel Assistant</span>
            </div>
            <div className="cw-head-actions">
              <button
                onClick={() => { setMessages([]); }}
                title="Reset conversation"
                aria-label="Reset conversation"
                disabled={!messages.length}
              >
                <RotateCcw size={14} />
              </button>
              <button
                onClick={() => navigate('/assistant')}
                title="Open full assistant"
                aria-label="Open full assistant"
              >
                <Maximize2 size={14} />
              </button>
              <button onClick={() => setOpen(false)} title="Close" aria-label="Close">
                <X size={15} />
              </button>
            </div>
          </div>

          <div className="cw-thread" ref={threadRef}>
            {messages.length === 0 && !sending && (
              <div className="cw-empty">
                <Bot size={26} strokeWidth={1.4} />
                <p>Ask about cases, districts, officers or procedure — answers come from the FIR Data Store and the knowledge base.</p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`cw-msg cw-msg-${m.role}`}>
                {m.role === 'assistant' ? (
                  <>
                    {m.content && <div className="cw-bubble"><RichText text={m.content} /></div>}
                    <AguiRenderer components={m.components} />
                    {Array.isArray(m.sources) && m.sources.length > 0 && (
                      <div className="cw-sources">
                        {m.source === 'fallback' ? '' : 'Sources: '}
                        {m.sources.join(' · ')}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="cw-bubble">{m.content}</div>
                )}
              </div>
            ))}
            {sending && (
              <div className="cw-msg cw-msg-assistant">
                <div className="cw-bubble"><div className="as-typing"><span /><span /><span /></div></div>
              </div>
            )}
          </div>

          <div className="cw-composer">
            <input
              ref={inputRef}
              className="cw-input"
              placeholder="Ask Sentinel…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            />
            <button
              className="cw-send"
              onClick={send}
              disabled={!input.trim() || sending}
              aria-label="Send"
            >
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
