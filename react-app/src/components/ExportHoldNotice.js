// What the officer sees when an export is held.
//
// The tone here is deliberate and it is the whole design. Being held is not an
// accusation and the officer has done nothing wrong — they assembled a document
// that happens to contain something departmental policy says a second person
// should sign off on. If this screen reads as "you are suspected of something",
// officers route around the feature: they screenshot the page, or they stop
// using Report Studio. So it states the reason plainly, names what happens
// next, and gets out of the way.
//
// It also refuses to leave the export in limbo. A download that silently never
// arrives is the worst outcome available, because the officer assumes it
// worked and only finds out later that it did not. So the dialog polls its own
// request and, the moment a supervisor approves, offers the download again.
import { Link } from 'react-router-dom';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileLock2, Loader2, ShieldAlert, X, CornerUpLeft } from 'lucide-react';
import { fetchExportStatus } from '../utils/exportGate';

const POLL_MS = 6000;

export default function ExportHoldNotice({ hold, onRetry, onClose }) {
  const [status, setStatus] = useState('pending');
  const [note, setNote] = useState('');
  const [decidedBy, setDecidedBy] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef(null);

  const approvalId = hold?.approvalId;

  const poll = useCallback(async () => {
    if (!approvalId) return;
    try {
      const req = await fetchExportStatus(approvalId);
      if (!req) return;
      setStatus(req.status);
      setNote(req.note || '');
      setDecidedBy(req.decidedName || req.decidedBy || '');
    } catch {
      // A failed poll is not worth an error message — the next one is six
      // seconds away, and the officer can always close and export again.
    }
  }, [approvalId]);

  useEffect(() => {
    // Keep polling while the request is still moving. A hold that has been sent
    // back can become pending again when the officer revises it, so stopping at
    // the first non-pending status would freeze this dialog mid-conversation.
    if (status !== 'pending') return undefined;
    timer.current = setInterval(poll, POLL_MS);
    return () => clearInterval(timer.current);
  }, [status, poll]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const retry = async () => {
    setRetrying(true);
    setError('');
    try {
      await onRetry?.(approvalId);
      onClose?.();
    } catch (e) {
      setError(e?.message || 'The download could not be completed.');
    } finally {
      setRetrying(false);
    }
  };

  if (!hold) return null;

  return (
    <div className="xh-scrim" onMouseDown={onClose}>
      <div
        className={`xh-modal ${status}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="xh-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className="xh-close" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>

        {status === 'pending' && (
          <>
            <div className="xh-head">
              <span className="xh-icon"><FileLock2 size={16} strokeWidth={2.1} /></span>
              <div>
                <h3 id="xh-title">Waiting for supervisor approval</h3>
                <p className="xh-sub">
                  This report contains material that needs a second signature before it
                  leaves Sentinel. Your request has gone to the supervisors on duty.
                </p>
              </div>
            </div>

            <ul className="xh-reasons">
              {(hold.reasons || []).map((r, i) => (
                <li key={`${r.category}-${i}`}>
                  <b>{r.label}</b>
                  <span className="xh-why">{r.why}</span>
                  <span className="xh-ev">matched: {r.evidence}</span>
                </li>
              ))}
            </ul>

            <p className="xh-foot">
              <Loader2 size={12} className="xh-spin" /> Checking every few seconds — you can
              close this and keep working. Nothing has been sent anywhere.
            </p>
          </>
        )}

        {status === 'approved' && (
          <>
            <div className="xh-head">
              <span className="xh-icon ok"><CheckCircle2 size={16} strokeWidth={2.1} /></span>
              <div>
                <h3 id="xh-title">Approved{decidedBy ? ` by ${decidedBy}` : ''}</h3>
                <p className="xh-sub">
                  {note || 'The export was authorised. Download it now — the approval covers this one document.'}
                </p>
              </div>
            </div>
            {error && <p className="xh-error">{error}</p>}
            <div className="xh-actions">
              <button type="button" className="xh-btn ghost" onClick={onClose}>Not now</button>
              <button type="button" className="xh-btn solid" onClick={retry} disabled={retrying}>
                {retrying ? 'Downloading…' : 'Download'}
              </button>
            </div>
          </>
        )}

        {status === 'changes_requested' && (
          <>
            <div className="xh-head">
              <span className="xh-icon warn"><CornerUpLeft size={16} strokeWidth={2.1} /></span>
              <div>
                <h3 id="xh-title">Sent back for changes</h3>
                <p className="xh-sub">
                  {note || 'The supervisor has asked for changes before this can leave Sentinel.'}
                </p>
                <p className="xh-sub">
                  Open the review to read the comments on each passage. Make the changes and export
                  again — the new version attaches to the same review, so nothing is repeated.
                </p>
              </div>
            </div>
            <div className="xh-actions">
              <Link className="xh-btn solid" to={`/export-review/${approvalId}`} onClick={onClose}>
                Read the comments
              </Link>
              <button type="button" className="xh-btn" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {(status === 'rejected' || status === 'expired') && (
          <>
            <div className="xh-head">
              <span className="xh-icon no"><ShieldAlert size={16} strokeWidth={2.1} /></span>
              <div>
                <h3 id="xh-title">
                  {status === 'rejected'
                    ? `Not approved${decidedBy ? ` — ${decidedBy}` : ''}`
                    : 'This request expired'}
                </h3>
                <p className="xh-sub">
                  {status === 'rejected'
                    ? (note || 'The supervisor did not authorise this export. Speak to them before trying again.')
                    : 'Nobody acted on it in time. Export again to raise a fresh request.'}
                </p>
              </div>
            </div>
            <div className="xh-actions">
              <button type="button" className="xh-btn solid" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
