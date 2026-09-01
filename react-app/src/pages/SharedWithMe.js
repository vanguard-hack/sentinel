// What other officers have sent you.
//
// A plain inbox, and deliberately plain. The value is not the list — every
// investigator can already open every diary and report — it is knowing that a
// named colleague wanted YOU to look at this one, and why. So the note and the
// sender are the loudest things on each row, and the document title is second.
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Inbox, MailOpen, NotebookPen, RefreshCw, ScrollText, UserRound,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import { fetchInbox, markShareRead, shareTarget, KIND_LABEL } from '../utils/sharing';
import { logAudit } from '../utils/audit';

const KIND_ICON = { diary: NotebookPen, report: ScrollText };

const fmt = (ts) =>
  ts ? new Date(ts).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : '';

export default function SharedWithMe() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const d = await fetchInbox();
      setItems(d.shares || []);
    } catch (e) {
      setError(e.message);
      setItems([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { logAudit('shared-open', 'Sharing', '/shared'); }, []);

  const open = async (s) => {
    if (s.readAt) return;
    try {
      await markShareRead(s.id);
      setItems((prev) => prev.map((x) => (x.id === s.id ? { ...x, readAt: Date.now() } : x)));
    } catch {
      // Not worth an error message — the officer is on their way to the
      // document, and a failed read-receipt must not stand in front of it.
    }
  };

  // No withdraw here, deliberately. This is the RECIPIENT's view, and only the
  // officer who sent a share can take it back — offering the button to the
  // wrong side would put a 403 behind it. Withdrawing lives on the document,
  // beside the list of who it went to.
  const unread = (items || []).filter((s) => !s.readAt).length;

  return (
    <>
      <TopBar title="Shared with me" />
      <main className="rp-main sw-page">
        <header className="sw-head">
          <h2><Inbox size={18} aria-hidden="true" /> Shared with me</h2>
          <p className="aa-hint">
            Diaries and reports a colleague has pointed you at. Every investigator can already open
            these records — a share says who wanted you to look, and why.
          </p>
          <button type="button" className="btn-sm ghost" onClick={load}>
            <RefreshCw size={13} aria-hidden="true" /> Refresh
          </button>
        </header>

        {error && <p className="sw-error">{error}</p>}

        {items === null && <p className="sw-empty">Loading…</p>}

        {items !== null && items.length === 0 && !error && (
          <p className="sw-empty">
            Nothing has been shared with you yet. When a colleague sends you a case diary or a
            report it will appear here.
          </p>
        )}

        {!!(items || []).length && (
          <>
            {unread > 0 && (
              <p className="sw-unread">{unread} unread</p>
            )}
            <ul className="sw-list">
              {items.map((s) => {
                const Icon = KIND_ICON[s.kind] || ScrollText;
                return (
                  <li key={s.id} className={`sw-item${s.readAt ? '' : ' unread'}`}>
                    <span className="sw-icon"><Icon size={15} aria-hidden="true" /></span>
                    <div className="sw-body">
                      <p className="sw-from">
                        <UserRound size={12} aria-hidden="true" />
                        <b>{s.fromName || s.from}</b> shared a {String(KIND_LABEL[s.kind] || 'document').toLowerCase()}
                        <time>{fmt(s.at)}</time>
                      </p>
                      <Link className="sw-title" to={shareTarget(s)} onClick={() => open(s)}>
                        {s.title || s.docId}
                      </Link>
                      {s.note && <p className="sw-note">“{s.note}”</p>}
                    </div>
                    <div className="sw-actions">
                      {!s.readAt && (
                        <button type="button" className="btn-sm ghost" onClick={() => open(s)}>
                          <MailOpen size={12} aria-hidden="true" /> Mark read
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </main>
    </>
  );
}
