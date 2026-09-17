import React, { useState } from 'react';
import { ShieldOff, Copy, Check, AlertTriangle, EyeOff } from 'lucide-react';
import TopBar from '../components/TopBar';
import { useAccess } from '../context/AccessContext';
import { anonymizeText, revealText } from '../utils/anonymize';

// Mirrors redaction.js's PROTECTED_CLEARANCE tier (functions/rag/redaction.js
// ROLE_CLEARANCE: admin/supervisor/investigator = 3) for UI purposes only —
// the server re-checks clearance on every /anonymize/reveal call regardless.
const CAN_REVEAL = new Set(['admin', 'supervisor', 'investigator']);

export default function Anonymize() {
  const { role } = useAccess();
  const [input, setInput] = useState('');
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState({ state: 'idle', error: null });
  const [copied, setCopied] = useState(false);

  const [revealInput, setRevealInput] = useState('');
  const [revealOutput, setRevealOutput] = useState('');
  const [revealStatus, setRevealStatus] = useState({ state: 'idle', error: null });

  const runAnonymize = async () => {
    if (!input.trim()) return;
    setStatus({ state: 'sending', error: null });
    setResult(null);
    try {
      const data = await anonymizeText(input);
      setResult(data);
      setRevealInput(data.anonymizedText);
      setRevealOutput('');
      setStatus({ state: 'idle', error: null });
    } catch (err) {
      setStatus({ state: 'idle', error: err.message });
    }
  };

  const copyResult = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.anonymizedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the browser; the text is still
      // visible and selectable in the textarea, so this is non-fatal.
    }
  };

  const runReveal = async () => {
    if (!result?.mapId || !revealInput.trim()) return;
    setRevealStatus({ state: 'sending', error: null });
    try {
      const text = await revealText(result.mapId, revealInput);
      setRevealOutput(text);
      setRevealStatus({ state: 'idle', error: null });
    } catch (err) {
      setRevealStatus({ state: 'idle', error: err.message });
    }
  };

  return (
    <div className="cf-page">
      <TopBar title="Anonymize" />
      <div className="pp-body">
        <div className="an-layout">
          <div className="an-intro">
            <div className="an-badge"><ShieldOff size={22} /></div>
            <h1>Anonymize</h1>
            <p className="an-lead">
              Paste an FIR narrative, chargesheet excerpt, or statement. Names, places,
              dates and identifiers are replaced with consistent placeholders — the same
              person or place always gets the same placeholder, so the result stays
              useful for pattern and link analysis.
            </p>
          </div>

          <div className="an-card">
            <label className="an-field">
              <span>Text to anonymize</span>
              <textarea
                className="an-input an-textarea"
                rows={8}
                placeholder="Paste text here…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            </label>

            {status.error && (
              <div className="aa-error"><AlertTriangle size={16} /> {status.error}</div>
            )}

            <button
              type="button"
              className="an-submit"
              disabled={status.state === 'sending' || !input.trim()}
              onClick={runAnonymize}
            >
              {status.state === 'sending' ? 'Anonymizing…' : 'Anonymize'}
            </button>

            {result && (
              <div className="an-result">
                <div className="an-result-head">
                  <span>Anonymized text</span>
                  <button type="button" className="an-copy" onClick={copyResult}>
                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <textarea className="an-input an-textarea" rows={8} readOnly value={result.anonymizedText} />
                <div className="an-counts">
                  {Object.entries(result.entityCounts || {}).map(([type, count]) => (
                    <span className="an-badge-chip" key={type}>{type}: {count}</span>
                  ))}
                  {!result.nerAvailable && (
                    <span className="an-badge-chip an-badge-warn">
                      Name/place detection degraded — only structured identifiers were removed
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {result && CAN_REVEAL.has(role) && (
            <div className="an-card">
              <div className="an-field">
                <span><EyeOff size={14} /> Reveal identities</span>
                <p className="an-lead an-lead-small">
                  Paste the anonymized text back — including any report built from it — and
                  the original names, places and identifiers are restored.
                </p>
              </div>
              <label className="an-field">
                <span>Text to reveal</span>
                <textarea
                  className="an-input an-textarea"
                  rows={6}
                  value={revealInput}
                  onChange={(e) => setRevealInput(e.target.value)}
                />
              </label>

              {revealStatus.error && (
                <div className="aa-error"><AlertTriangle size={16} /> {revealStatus.error}</div>
              )}

              <button
                type="button"
                className="an-submit"
                disabled={revealStatus.state === 'sending' || !revealInput.trim()}
                onClick={runReveal}
              >
                {revealStatus.state === 'sending' ? 'Revealing…' : 'Reveal'}
              </button>

              {revealOutput && (
                <textarea className="an-input an-textarea" rows={6} readOnly value={revealOutput} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
