import React, { useState } from 'react';
import { LifeBuoy, Mail, Phone, Send, CheckCircle2, AlertTriangle } from 'lucide-react';
import TopBar from '../components/TopBar';
import { useAuth } from '../context/AuthContext';

const CATEGORIES = [
  'Login & access',
  'Data & reports',
  'AI Analytics',
  'Investigation Diary',
  'Bug report',
  'Feature request',
  'Other',
];

const SUPPORT_EMAIL = 'deepujohn.t01@gmail.com';
const SUPPORT_PHONE = '+91 79949 05875';

export default function HelpCenter() {
  const { user } = useAuth();
  const [email, setEmail] = useState(user?.email_id || '');
  const [category, setCategory] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState({ state: 'idle', error: null }); // idle | sending | sent | error

  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ');

  const submit = async (e) => {
    e.preventDefault();
    if (!message.trim()) return;
    setStatus({ state: 'sending', error: null });
    try {
      const res = await fetch('/server/rag/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, category: category || 'General', message, name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus({ state: 'sent', error: null });
      setMessage('');
      setCategory('');
    } catch (err) {
      setStatus({ state: 'error', error: err.message });
    }
  };

  return (
    <div className="cf-page">
      <TopBar title="Help Center" />
      <div className="pp-body">
        <div className="hc-layout">
          {/* Left: intro + direct contact */}
          <div className="hc-intro">
            <div className="hc-badge"><LifeBuoy size={22} /></div>
            <h1>Help Center</h1>
            <p className="hc-lead">
              Running into a problem or have a suggestion? Tell us what’s happening and the
              team will get back to you. Sign-in details are filled in automatically so we can
              follow up.
            </p>

            <div className="hc-contact">
              <span className="hc-contact-label">Prefer to reach us directly?</span>
              <a className="hc-contact-row" href={`mailto:${SUPPORT_EMAIL}`}>
                <Mail size={16} /> {SUPPORT_EMAIL}
              </a>
              <a className="hc-contact-row" href={`tel:${SUPPORT_PHONE.replace(/\s/g, '')}`}>
                <Phone size={16} /> {SUPPORT_PHONE}
              </a>
            </div>
          </div>

          {/* Right: request form */}
          <form className="hc-card" onSubmit={submit}>
            {status.state === 'sent' ? (
              <div className="hc-success">
                <CheckCircle2 size={40} />
                <h2>Request sent</h2>
                <p>
                  Thanks — your message is on its way to the team. We’ll reach out at{' '}
                  <strong>{email || 'your email'}</strong>. You can also contact us directly at{' '}
                  {SUPPORT_EMAIL} or {SUPPORT_PHONE}.
                </p>
                <button
                  type="button"
                  className="aa-btn"
                  onClick={() => setStatus({ state: 'idle', error: null })}
                >
                  Send another request
                </button>
              </div>
            ) : (
              <>
                <label className="hc-field">
                  <span>Your email address</span>
                  <input
                    type="email"
                    className="hc-input"
                    placeholder="Enter your email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>

                <div className="hc-field">
                  <span>What do you need help with?</span>
                  <div className="hc-chips">
                    {CATEGORIES.map((c) => (
                      <button
                        type="button"
                        key={c}
                        className={`hc-chip ${category === c ? 'active' : ''}`}
                        onClick={() => setCategory(category === c ? '' : c)}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="hc-field">
                  <span>Describe the issue</span>
                  <textarea
                    className="hc-input hc-textarea"
                    rows={6}
                    placeholder="Tell us what happened, what you expected, and any steps to reproduce it…"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    required
                  />
                </label>

                {status.state === 'error' && (
                  <div className="aa-error"><AlertTriangle size={16} /> {status.error}</div>
                )}

                <button
                  type="submit"
                  className="hc-submit"
                  disabled={status.state === 'sending' || !message.trim()}
                >
                  {status.state === 'sending' ? 'Sending…' : <>Send your request <Send size={16} /></>}
                </button>
              </>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
