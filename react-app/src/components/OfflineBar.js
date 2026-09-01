import React, { useEffect, useState } from 'react';
import { CloudOff, RefreshCw, Check, AlertTriangle } from 'lucide-react';
import {
  isOnline, onConnectionChange, onQueueChange, pendingCount, pendingWrites,
  flushQueue, discardWrite,
} from '../utils/offline';
import { useConfirm } from './ConfirmDialog';

// Connection and sync state, shown only when it matters.
//
// An officer must never be left guessing whether what they typed reached the
// server — on a police record that ambiguity is the whole problem. So the bar
// appears when the connection drops OR when anything is still queued, states
// what is unsynced in their words, and disappears once everything has landed.
export default function OfflineBar() {
  const [online, setOnline] = useState(isOnline());
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [justSynced, setJustSynced] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    pendingCount().then(setCount).catch(() => {});
    const offConn = onConnectionChange(setOnline);
    const offQueue = onQueueChange(setCount);
    return () => { offConn(); offQueue(); };
  }, []);

  useEffect(() => {
    if (open) pendingWrites().then(setItems).catch(() => setItems([]));
  }, [open, count]);

  // A brief confirmation when the last queued item lands, then the bar retires
  // itself. Silence after a sync reads the same as a sync that never happened.
  useEffect(() => {
    if (count === 0 && syncing === false && justSynced) {
      const t = setTimeout(() => setJustSynced(false), 4000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [count, syncing, justSynced]);

  const sync = async () => {
    setSyncing(true);
    const res = await flushQueue();
    setSyncing(false);
    if (res.sent > 0) setJustSynced(true);
  };

  const discard = async (id) => {
    const ok = await confirm({
      title: 'Discard this unsynced change?',
      body: 'It has not reached the server and cannot be recovered.',
      confirmLabel: 'Discard change',
      tone: 'danger',
    });
    if (!ok) return;
    await discardWrite(id);
  };

  if (online && count === 0 && !justSynced) return null;

  return (
    <div className={`off-bar ${online ? 'off-bar-pending' : 'off-bar-offline'}`}>
      <div className="off-bar-main">
        {online ? (
          justSynced && count === 0
            ? <><Check size={15} /> <span>All changes synced.</span></>
            : <><AlertTriangle size={15} /> <span>{count} {count === 1 ? 'change' : 'changes'} waiting to sync.</span></>
        ) : (
          <>
            <CloudOff size={15} />
            <span>
              Working offline — maps, stations and the org chart are available.
              Case records and the assistant need a connection.
              {count > 0 && ` ${count} ${count === 1 ? 'change' : 'changes'} saved on this device.`}
            </span>
          </>
        )}
        <div className="off-bar-actions">
          {count > 0 && (
            <button type="button" className="off-bar-btn" onClick={() => setOpen((o) => !o)}>
              {open ? 'Hide' : 'View'}
            </button>
          )}
          {online && count > 0 && (
            <button type="button" className="off-bar-btn primary" onClick={sync} disabled={syncing}>
              <RefreshCw size={13} className={syncing ? 'spin' : undefined} /> {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          )}
        </div>
      </div>

      {open && count > 0 && (
        <ul className="off-bar-list">
          {items.map((it) => (
            <li key={it.id}>
              <span className="off-bar-label">{it.label}</span>
              <span className="off-bar-when">
                written {new Date(it.authoredAt).toLocaleString('en-IN', {
                  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                })}
              </span>
              <button type="button" className="off-bar-discard" onClick={() => discard(it.id)}>Discard</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
