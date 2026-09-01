// The supervisor's queue for held exports.
//
// The screen that decides whether this control survives contact with a real
// station is this one, and the thing that would kill it is volume. A queue that
// shows dozens of items a day gets cleared with a rhythm of clicks and stops
// being a decision — which is why the screening rules behind it are narrow
// enough that a routine FIR never lands here. Everything on this page is
// therefore something a person is genuinely meant to read.
//
// So the reasons are shown in full, not as a badge count, and rejecting asks
// for a sentence: the officer waiting on the other end needs to know what to
// change, and "rejected" on its own tells them nothing.
import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2, Clock, CornerUpLeft, FileLock2, FileSearch, Inbox, RefreshCw, ShieldAlert, ShieldCheck, XCircle,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import TopBar from '../components/TopBar';
import { fetchExportRequests, decideExport } from '../utils/exportGate';
import { logAudit } from '../utils/audit';

const TABS = [
  { key: 'pending', label: 'Awaiting decision', icon: Clock },
  { key: 'changes_requested', label: 'Sent back', icon: CornerUpLeft },
  { key: 'approved', label: 'Approved', icon: CheckCircle2 },
  { key: 'rejected', label: 'Not approved', icon: XCircle },
];

const KIND_LABELS = {
  'report-studio': 'Report Studio',
  'case-diary': 'Case Diary',
  'investigation-summary': 'Investigation Summary',
  'assistant-transcript': 'Assistant transcript',
  dashboard: 'Dashboard',
};

const fmt = (ts) =>
  ts
    ? new Date(ts).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : '—';

function waitedFor(ts) {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr`;
  return `${Math.round(hrs / 24)} d`;
}

export default function ExportApprovals() {
  const [tab, setTab] = useState('pending');
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [rejecting, setRejecting] = useState(null); // id of the row asking for a reason
  const [reason, setReason] = useState('');

  const load = useCallback(async (which) => {
    setError('');
    try {
      setItems(await fetchExportRequests(which));
    } catch (e) {
      setItems([]);
      setError(e?.message || 'Could not load the queue.');
    }
  }, []);

  useEffect(() => { load(tab); }, [tab, load]);

  // The officer on the other end is blocked until someone acts, so the queue
  // refreshes itself rather than relying on a supervisor to press reload.
  useEffect(() => {
    if (tab !== 'pending') return undefined;
    const t = setInterval(() => load('pending'), 30000);
    return () => clearInterval(t);
  }, [tab, load]);

  const decide = async (req, decision, note) => {
    setBusyId(req.id);
    setError('');
    try {
      await decideExport(req.id, decision, note);
      logAudit(
        decision === 'approved' ? 'approve-export' : 'reject-export',
        'Export Control',
        `${req.title} — ${req.requestedName || req.requestedBy}`,
      );
      setRejecting(null);
      setReason('');
      await load(tab);
    } catch (e) {
      setError(e?.message || 'Could not record the decision.');
    } finally {
      setBusyId(null);
    }
  };

  const list = items || [];

  return (
    <div className="page">
      <TopBar title="Export Approvals" subtitle="Documents held for a second signature" />

      <div className="xa-intro">
        <ShieldCheck size={15} />
        <p>
          Sentinel screens every report on its way out. Most leave immediately; these tripped a rule
          that departmental policy says a second officer should look at. You cannot approve your own
          request — a different officer has to decide.
        </p>
      </div>

      <div className="xa-tabs">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            className={`xa-tab ${tab === key ? 'on' : ''}`}
            onClick={() => setTab(key)}
          >
            <Icon size={13} /> {label}
            {key === 'pending' && tab === 'pending' && list.length > 0 && (
              <span className="xa-count">{list.length}</span>
            )}
          </button>
        ))}
        <button type="button" className="xa-refresh" onClick={() => load(tab)} title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      {error && <div className="xa-error"><ShieldAlert size={14} /> {error}</div>}

      {items === null && <div className="xa-empty">Loading…</div>}

      {items !== null && list.length === 0 && (
        <div className="xa-empty">
          <Inbox size={22} />
          <p>
            {tab === 'pending'
              ? 'Nothing is waiting. Reports that clear the screen download without ever reaching this page.'
              : 'Nothing here yet.'}
          </p>
        </div>
      )}

      <div className="xa-list">
        {list.map((req) => (
          <article key={req.id} className={`xa-card ${req.status}`}>
            <header className="xa-card-head">
              <span className="xa-kind"><FileLock2 size={12} /> {KIND_LABELS[req.kind] || req.kind}</span>
              <h3>{req.title}</h3>
              <p className="xa-who">
                {req.requestedName || req.requestedBy}
                <span className="xa-role">{req.requestedRole}</span>
                <span className="xa-time">
                  {req.status === 'pending'
                    ? `waiting ${waitedFor(req.requestedAt)}`
                    : `requested ${fmt(req.requestedAt)}`}
                </span>
              </p>
            </header>

            <p className="xa-open-review">
              <Link to={`/export-review/${req.id}`}>
                <FileSearch size={13} aria-hidden="true" />
                {req.status === 'pending' ? 'Read the document and comment' : 'Open the review'}
              </Link>
              {(req.revisions || []).length > 1 && (
                <span className="xa-revs">revision {req.revisions.length}</span>
              )}
            </p>

            <ul className="xa-reasons">
              {(req.reasons || []).map((r, i) => (
                <li key={`${r.category}-${i}`}>
                  <b>{r.label}</b>
                  <span className="xa-why">{r.why}</span>
                  <code>{r.evidence}</code>
                </li>
              ))}
            </ul>

            {req.status === 'pending' && rejecting === req.id && (
              <div className="xa-reject">
                <label htmlFor={`why-${req.id}`}>
                  What does the officer need to change? They will see this.
                </label>
                <textarea
                  id={`why-${req.id}`}
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Redact the witness name in section 13, then export again."
                />
                <div className="xa-actions">
                  <button
                    type="button"
                    className="xa-btn ghost"
                    onClick={() => { setRejecting(null); setReason(''); }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="xa-btn danger"
                    disabled={!reason.trim() || busyId === req.id}
                    onClick={() => decide(req, 'rejected', reason.trim())}
                  >
                    Send back
                  </button>
                </div>
              </div>
            )}

            {req.status === 'pending' && rejecting !== req.id && (
              <div className="xa-actions">
                <button
                  type="button"
                  className="xa-btn ghost"
                  onClick={() => { setRejecting(req.id); setReason(''); }}
                >
                  <XCircle size={13} /> Not approved
                </button>
                <button
                  type="button"
                  className="xa-btn solid"
                  disabled={busyId === req.id}
                  onClick={() => decide(req, 'approved', '')}
                >
                  <CheckCircle2 size={13} /> {busyId === req.id ? 'Recording…' : 'Approve export'}
                </button>
              </div>
            )}

            {req.status !== 'pending' && (
              <footer className="xa-decided">
                {req.status === 'approved' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                <span>
                  {req.status === 'approved' ? 'Approved' : 'Not approved'} by{' '}
                  {req.decidedName || req.decidedBy} · {fmt(req.decidedAt)}
                  {req.consumedAt ? ' · downloaded' : req.status === 'approved' ? ' · not yet downloaded' : ''}
                </span>
                {req.note && <em>“{req.note}”</em>}
              </footer>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
