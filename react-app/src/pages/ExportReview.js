// Reviewing a held export, line by line.
//
// The control this belongs to had a hole in it. A supervisor was shown a title,
// two matched words and the requester's name, and asked to approve or reject —
// so they were signing for a document they had never read. That is
// rubber-stamping with a signature attached, and it is the exact failure the
// screening rules were made narrow to avoid.
//
// So this page shows the document with every flagged passage highlighted,
// lets either side attach a comment to a specific passage, and keeps the two
// of them talking on the same hold until the objections are answered. The
// officer sees what has to change and resubmits; the supervisor sees a
// revision rather than a fresh request to read cold.
//
// Two deliberate rules run through the whole screen:
//   • The agent explains, a person decides. Its notes are labelled as
//     machine-written and open unresolved, so a human still has to close them.
//   • The reviewer alone resolves a thread. An officer who could close the
//     objections against their own document would be approving it themselves.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Bot, Check, CheckCircle2, CornerUpLeft, FileText, Loader2,
  MessageSquarePlus, RefreshCw, Send, ShieldAlert, Undo2, User,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import {
  fetchExportReview, addReviewThread, addReviewComment, resolveReviewThread,
  annotateExportReview, requestExportChanges, decideExport,
  highlightSpans, segmentText,
} from '../utils/exportGate';
import { logAudit } from '../utils/audit';

const fmt = (ts) =>
  ts ? new Date(ts).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : '';

const AUTHOR_ICON = { agent: Bot, supervisor: ShieldAlert, officer: User };

function Comment({ c }) {
  const Icon = AUTHOR_ICON[c.kind] || User;
  return (
    <li className={`xr-comment xr-comment-${c.kind}`}>
      <span className="xr-comment-who">
        <Icon size={13} aria-hidden="true" />
        {c.kind === 'agent' ? 'Sentinel' : c.authorName || c.author}
        {c.kind === 'agent' && <em className="xr-badge-agent">drafted by the assistant</em>}
        <time>{fmt(c.at)}</time>
      </span>
      <p>{c.body}</p>
    </li>
  );
}

function Thread({ thread, canResolve, onReply, onResolve, active, onSelect, busy }) {
  const [draft, setDraft] = useState('');
  const open = !thread.resolved && !thread.outdated;

  return (
    <li
      className={`xr-thread${active ? ' active' : ''}${thread.resolved ? ' resolved' : ''}${thread.outdated ? ' outdated' : ''}`}
      id={`thread-${thread.id}`}
    >
      <button type="button" className="xr-thread-head" onClick={() => onSelect(thread.id)}>
        <span className="xr-thread-state">
          {thread.outdated ? 'Outdated' : thread.resolved ? 'Resolved' : 'Open'}
        </span>
        {thread.finding && <span className="xr-thread-rule">{thread.finding.label}</span>}
      </button>

      <blockquote className="xr-quote">{thread.anchor.quote}</blockquote>
      {thread.outdated && (
        <p className="xr-outdated-note">
          This text is no longer in the document — the officer has changed it. Kept for the record;
          it no longer blocks approval.
        </p>
      )}
      {thread.ambiguous > 1 && !thread.outdated && (
        <p className="xr-outdated-note">
          This wording now appears {thread.ambiguous} times. Showing the closest match to where the
          comment was first placed.
        </p>
      )}
      {thread.finding && <p className="xr-thread-why">{thread.finding.why}</p>}

      <ul className="xr-comments">
        {(thread.comments || []).map((c) => <Comment key={c.id} c={c} />)}
      </ul>

      <div className="xr-reply">
        <label className="sr-only" htmlFor={`reply-${thread.id}`}>Reply to this comment</label>
        <textarea
          id={`reply-${thread.id}`}
          rows={2}
          value={draft}
          placeholder="Reply…"
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="xr-reply-actions">
          <button
            type="button"
            className="btn-sm"
            disabled={!draft.trim() || busy}
            onClick={async () => { await onReply(thread.id, draft.trim()); setDraft(''); }}
          >
            <Send size={13} aria-hidden="true" /> Reply
          </button>
          {canResolve && open && (
            <button type="button" className="btn-sm ghost" disabled={busy} onClick={() => onResolve(thread.id, true)}>
              <Check size={13} aria-hidden="true" /> Resolve
            </button>
          )}
          {canResolve && thread.resolved && (
            <button type="button" className="btn-sm ghost" disabled={busy} onClick={() => onResolve(thread.id, false)}>
              <Undo2 size={13} aria-hidden="true" /> Reopen
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export default function ExportReview() {
  const { approvalId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [active, setActive] = useState(null);
  const [selection, setSelection] = useState(null);
  const [newComment, setNewComment] = useState('');
  const [note, setNote] = useState('');
  const [returning, setReturning] = useState(false);
  const docRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setError('');
      setData(await fetchExportReview(approvalId));
    } catch (e) {
      setError(e.message);
    }
  }, [approvalId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { logAudit('export-review-open', 'Export Control', `/export-review/${approvalId}`); }, [approvalId]);

  const spans = useMemo(
    () => highlightSpans(data?.findings || [], data?.threads || []),
    [data],
  );
  const pieces = useMemo(() => segmentText(data?.text || '', spans), [data, spans]);
  const openCount = (data?.threads || []).filter((t) => !t.resolved && !t.outdated).length;

  /** Turn a text selection in the document into an anchor for a new thread. */
  const captureSelection = () => {
    const sel = window.getSelection();
    const text = String(sel || '').trim();
    if (!text || !docRef.current || !docRef.current.contains(sel.anchorNode)) return;
    // Offsets are found by searching the source text for the selected string
    // rather than walking DOM ranges: the rendered document is already split
    // into highlight fragments, so DOM offsets do not correspond to positions
    // in the text the server holds.
    const start = (data?.text || '').indexOf(text);
    if (start === -1) return;
    setSelection({ start, end: start + text.length, quote: text });
  };

  const run = async (label, fn) => {
    setBusy(label);
    try {
      const out = await fn();
      if (out && out.threads) setData((d) => ({ ...d, threads: out.threads }));
      return out;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy('');
    }
  };

  if (error && !data) {
    return (
      <>
        <TopBar title="Export review" />
        <main className="rp-main">
          <p className="xr-error">{error}</p>
          <button type="button" className="btn-sm" onClick={() => navigate('/export-approvals')}>
            <ArrowLeft size={14} aria-hidden="true" /> Back to the queue
          </button>
        </main>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <TopBar title="Export review" />
        <main className="rp-main"><p className="xr-loading">Opening the review…</p></main>
      </>
    );
  }

  const req = data.request;
  const canReview = data.canReview;

  return (
    <>
      <TopBar title="Export review" />
      <main className="rp-main xr-page">
        <button type="button" className="xr-back" onClick={() => navigate(canReview ? '/export-approvals' : '/reports')}>
          <ArrowLeft size={14} aria-hidden="true" /> Back
        </button>

        <header className="xr-head">
          <h2><FileText size={18} aria-hidden="true" /> {req.title}</h2>
          <p className="xr-meta">
            {req.requestedName || req.requestedBy}
            <span className="xr-dot">·</span>
            revision {data.revision} of {(req.revisions || []).length || 1}
            <span className="xr-dot">·</span>
            <span className={`xr-status xr-status-${req.status}`}>
              {req.status === 'changes_requested' ? 'changes requested' : req.status}
            </span>
          </p>
          {req.note && req.status === 'changes_requested' && (
            <p className="xr-returned">
              <CornerUpLeft size={14} aria-hidden="true" />
              Returned by {req.changesRequestedName || req.changesRequestedBy}: {req.note}
            </p>
          )}
        </header>

        {error && <p className="xr-error">{error}</p>}

        <div className="xr-split">
          {/* ── The document ─────────────────────────────────────────── */}
          <section className="xr-doc-wrap" aria-label="Document under review">
            <div className="xr-doc-bar">
              <span>{openCount} open · {(data.threads || []).length} total</span>
              {canReview && (
                <button
                  type="button"
                  className="btn-sm ghost"
                  disabled={!!busy}
                  onClick={() => run('annotate', () => annotateExportReview(approvalId))}
                  title="Ask the assistant to explain each flagged passage"
                >
                  {busy === 'annotate'
                    ? <Loader2 size={13} className="spin" aria-hidden="true" />
                    : <Bot size={13} aria-hidden="true" />}
                  Explain the flags
                </button>
              )}
              <button type="button" className="btn-sm ghost" onClick={load} disabled={!!busy}>
                <RefreshCw size={13} aria-hidden="true" /> Refresh
              </button>
            </div>

            {data.text ? (
              <div className="xr-doc" ref={docRef} onMouseUp={captureSelection}>
                {pieces.map((p, i) => (
                  p.span ? (
                    <mark
                      key={i}
                      className={`xr-mark xr-mark-${p.span.kind}${
                        active && (p.span.threads || []).some((t) => t.id === active) ? ' active' : ''}`}
                      onClick={() => {
                        const t = (p.span.threads || [])[0];
                        if (t) {
                          setActive(t.id);
                          document.getElementById(`thread-${t.id}`)?.scrollIntoView({ block: 'nearest' });
                        }
                      }}
                      title={(p.span.threads || [])[0]?.finding?.label || p.span.ref?.label || 'Flagged'}
                    >
                      {p.text}
                    </mark>
                  ) : <span key={i}>{p.text}</span>
                ))}
              </div>
            ) : (
              <p className="xr-nodoc">
                {/*
                  Two very different situations, and telling an officer the wrong
                  one sends them looking for a problem that is not there. A
                  finished export genuinely had its copy deleted; a request still
                  waiting never had one, because it was raised before documents
                  were kept for review — or the write failed.
                */}
                {['approved', 'rejected', 'expired'].includes(req.status)
                  ? 'The document for this revision is no longer stored — the copy is removed once an '
                    + 'export is released or expires. The flags and the discussion below are the record.'
                  : 'No copy of this document was kept. It was raised before Sentinel began storing '
                    + 'documents for review, so there is nothing to read here. Export the report again '
                    + 'to open a review you can comment on line by line.'}
              </p>
            )}

            {selection && (
              <div className="xr-newthread">
                <blockquote className="xr-quote">{selection.quote}</blockquote>
                <label className="sr-only" htmlFor="xr-new">Comment on the selected text</label>
                <textarea
                  id="xr-new"
                  rows={2}
                  value={newComment}
                  placeholder="What needs to change here?"
                  onChange={(e) => setNewComment(e.target.value)}
                />
                <div className="xr-reply-actions">
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={!newComment.trim() || !!busy}
                    onClick={async () => {
                      const ok = await run('thread', () => addReviewThread(approvalId, {
                        ...selection, body: newComment.trim(),
                      }));
                      if (ok) { setSelection(null); setNewComment(''); }
                    }}
                  >
                    <MessageSquarePlus size={13} aria-hidden="true" /> Add comment
                  </button>
                  <button type="button" className="btn-sm ghost" onClick={() => setSelection(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {!selection && data.text && (
              <p className="xr-hint">Select any part of the document to comment on it.</p>
            )}
          </section>

          {/* ── The conversation ─────────────────────────────────────── */}
          <aside className="xr-threads" aria-label="Review comments">
            {(data.threads || []).length === 0 ? (
              <p className="xr-empty">
                No comments yet.
                {canReview && ' Select a passage to raise one, or ask the assistant to explain the flags.'}
              </p>
            ) : (
              <ul className="xr-thread-list">
                {data.threads.map((t) => (
                  <Thread
                    key={t.id}
                    thread={t}
                    active={active === t.id}
                    busy={!!busy}
                    canResolve={canReview}
                    onSelect={setActive}
                    onReply={(id, body) => run('comment', () => addReviewComment(approvalId, id, body))}
                    onResolve={(id, resolved) => run('resolve', () => resolveReviewThread(approvalId, id, resolved))}
                  />
                ))}
              </ul>
            )}
          </aside>
        </div>

        {/* ── The decision ───────────────────────────────────────────── */}
        {canReview && req.status === 'pending' && (
          <footer className="xr-decide">
            {returning ? (
              <div className="xr-return">
                <label htmlFor="xr-note">What does the officer need to change? They will see this.</label>
                <textarea
                  id="xr-note" rows={2} value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Summarise what has to change before this can be approved."
                />
                <div className="xr-reply-actions">
                  <button
                    type="button" className="btn-sm" disabled={!note.trim() || !!busy}
                    onClick={async () => {
                      const ok = await run('changes', () => requestExportChanges(approvalId, note.trim()));
                      if (ok) { setReturning(false); setNote(''); load(); }
                    }}
                  >
                    <CornerUpLeft size={13} aria-hidden="true" /> Send back for changes
                  </button>
                  <button type="button" className="btn-sm ghost" onClick={() => setReturning(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="xr-decide-row">
                <button type="button" className="btn-sm ghost" disabled={!!busy} onClick={() => setReturning(true)}>
                  <CornerUpLeft size={13} aria-hidden="true" /> Request changes
                </button>
                <button
                  type="button"
                  className="btn-sm primary"
                  disabled={!!busy || openCount > 0}
                  title={openCount > 0
                    ? `${openCount} comment${openCount === 1 ? '' : 's'} still open — resolve or answer them first`
                    : 'Approve this export'}
                  onClick={async () => {
                    const ok = await run('approve', () => decideExport(approvalId, 'approved'));
                    if (ok) navigate('/export-approvals');
                  }}
                >
                  <CheckCircle2 size={13} aria-hidden="true" /> Approve
                </button>
                {openCount > 0 && (
                  <span className="xr-blocked">
                    {openCount} open comment{openCount === 1 ? '' : 's'} — resolve or answer
                    {openCount === 1 ? ' it' : ' them'} before approving.
                  </span>
                )}
              </div>
            )}
          </footer>
        )}

        {data.isOwner && req.status === 'changes_requested' && (
          <footer className="xr-decide">
            <p className="xr-owner-note">
              Make the changes in the report, then export again — Sentinel will attach the new version
              to this review so {req.changesRequestedName || 'the supervisor'} sees what changed rather
              than starting over.
            </p>
          </footer>
        )}
      </main>
    </>
  );
}
