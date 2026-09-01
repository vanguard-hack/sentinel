// Choosing which officers to send a diary or report to.
//
// The picker is a list of real Sentinel accounts, not the 881-strong personnel
// directory: a share addressed to someone who cannot sign in is a message that
// is never read and a sender who believes it was. Pending accounts are left out
// for the same reason.
import React, { useEffect, useMemo, useState } from 'react';
import {
  Check, Loader2, Search, Send, ShieldCheck, Undo2, UserRound, X,
} from 'lucide-react';
import {
  fetchOfficers, shareDocument, filterOfficers, fetchDocShares, revokeShare, KIND_LABEL,
} from '../utils/sharing';

const ROLE_LABEL = {
  admin: 'Administrator',
  supervisor: 'Supervisor',
  investigator: 'Investigator',
  analyst: 'Analyst',
  policymaker: 'Policy',
};

export default function ShareDialog({ kind, docId, title, onClose, onSent }) {
  const [officers, setOfficers] = useState(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  // Who it has already gone to. Shown above the picker so an officer can see
  // they are about to send it to someone who has had it for a week, and can
  // take it back from someone who should not have had it.
  const [already, setAlready] = useState([]);
  const [me, setMe] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchOfficers()
      .then((d) => { if (alive) { setOfficers(d.officers || []); setMe(d.me || null); } })
      .catch((e) => { if (alive) setError(e.message); });
    fetchDocShares(kind, docId)
      .then((d) => { if (alive) setAlready(d.shares || []); })
      .catch(() => { /* the picker is still usable without this */ });
    return () => { alive = false; };
  }, [kind, docId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = useMemo(() => filterOfficers(officers || [], query), [officers, query]);
  const toggle = (email) =>
    setPicked((p) => (p.includes(email) ? p.filter((x) => x !== email) : [...p, email]));

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const out = await shareDocument({ kind, docId, title, recipients: picked, note: note.trim() });
      setDone(out);
      onSent?.(out);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sh-scrim" onMouseDown={onClose}>
      <div
        className="sh-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sh-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className="sh-close" onClick={onClose} aria-label="Close">
          <X size={14} aria-hidden="true" />
        </button>

        <h3 id="sh-title">Share this {String(KIND_LABEL[kind] || 'document').toLowerCase()}</h3>
        <p className="sh-doc">{title}</p>

        {done ? (
          <div className="sh-done">
            <p>
              <Check size={15} aria-hidden="true" />
              {done.sent === 0
                ? 'Nobody new to send it to.'
                : `Sent to ${done.sent} officer${done.sent === 1 ? '' : 's'}.`}
            </p>
            {!!(done.skipped || []).length && (
              <p className="sh-skipped">
                Skipped: {done.skipped.map((s) => `${s.email} (${s.why})`).join(', ')}
              </p>
            )}
            <p className="sh-caveat">
              They will see it under <b>Shared with me</b>. Every investigator can already open this
              record — sharing points them at it, it does not change who may read it.
            </p>
            <button type="button" className="sh-btn solid" onClick={onClose}>Close</button>
          </div>
        ) : (
          <>
            {!!already.length && (
              <div className="sh-already">
                <p className="sh-already-head">Already shared with</p>
                <ul>
                  {already.map((a) => (
                    <li key={a.id}>
                      <span>{a.to}</span>
                      {a.readAt ? <em className="sh-read">read</em> : <em>unread</em>}
                      {/* Only the sender may withdraw — the server enforces it,
                          and offering the button to anyone else would put a 403
                          behind it. */}
                      {me && a.from === me.email && (
                        <button
                          type="button"
                          className="sh-withdraw"
                          onClick={async () => {
                            try {
                              await revokeShare(a.id, a.to);
                              setAlready((p) => p.filter((x) => x.id !== a.id));
                            } catch (e) { setError(e.message); }
                          }}
                        >
                          <Undo2 size={11} aria-hidden="true" /> Withdraw
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <label className="sh-search">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Search officers</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, address or role…"
              />
            </label>

            {error && <p className="sh-error">{error}</p>}

            <div className="sh-list" role="group" aria-label="Officers">
              {officers === null && !error && (
                <p className="sh-empty"><Loader2 size={13} className="spin" aria-hidden="true" /> Reading the directory…</p>
              )}
              {officers !== null && shown.length === 0 && (
                <p className="sh-empty">
                  {query ? 'No officer matches that.' : 'No other officers have accounts yet.'}
                </p>
              )}
              {shown.map((o) => {
                const on = picked.includes(o.email);
                return (
                  <button
                    type="button"
                    key={o.email}
                    className={`sh-officer${on ? ' on' : ''}`}
                    aria-pressed={on}
                    onClick={() => toggle(o.email)}
                  >
                    <span className="sh-avatar">
                      {o.role === 'admin' || o.role === 'supervisor'
                        ? <ShieldCheck size={14} aria-hidden="true" />
                        : <UserRound size={14} aria-hidden="true" />}
                    </span>
                    <span className="sh-who">
                      <b>{o.name}</b>
                      <em>{o.email}</em>
                    </span>
                    <span className="sh-role">{ROLE_LABEL[o.role] || o.role}</span>
                    {on && <Check size={14} className="sh-tick" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>

            <label className="sh-note" htmlFor="sh-note-field">
              A note, so they know what to look at
            </label>
            <textarea
              id="sh-note-field"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Check the seizure memo against the property list."
            />

            <div className="sh-actions">
              <span className="sh-count">
                {picked.length === 0 ? 'No one selected' : `${picked.length} selected`}
              </span>
              <button type="button" className="sh-btn" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="sh-btn solid"
                disabled={!picked.length || busy}
                onClick={send}
              >
                {busy
                  ? <Loader2 size={13} className="spin" aria-hidden="true" />
                  : <Send size={13} aria-hidden="true" />}
                Share
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
