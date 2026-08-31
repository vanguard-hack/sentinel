// Offline support: service-worker registration, connection state, and the
// queue that lets an officer keep working with no signal.
//
// The shape of this is set by one decision: no citizen data is cached to disk.
// The service worker caches the app, the maps and the reference tables and
// nothing else, so offline READS cover geography, stations and org structure —
// not FIR records. What the queue below holds is the officer's OWN work: a
// diary entry they typed at a scene. That is their composition, not a copy of
// somebody else's record, and it is deleted the moment it reaches the server.
//
// The honest limitation, surfaced in the UI rather than hidden: offline you can
// add to a case you already have open, but you cannot browse to one you have
// not loaded, because the case itself was never cached.

const QUEUE_DB = 'sentinel-offline';
const QUEUE_STORE = 'writes';
const DB_VERSION = 1;

// ── IndexedDB, minimal ──────────────────────────────────────────────────────
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUEUE_DB, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(QUEUE_STORE, mode);
    const store = t.objectStore(QUEUE_STORE);
    let out;
    try { out = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}

// ── Connection state ────────────────────────────────────────────────────────
// navigator.onLine only knows whether an interface is up — a station on a dead
// uplink reports "online" and every request still times out. Callers therefore
// treat a failed request as authoritative and call reportOffline().
let forcedOffline = false;
const listeners = new Set();

export const isOnline = () => navigator.onLine && !forcedOffline;

function emit() {
  const state = isOnline();
  listeners.forEach((fn) => { try { fn(state); } catch { /* a bad listener must not break the rest */ } });
}

export function onConnectionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A request failed in a way that looks like loss of connectivity. */
export function reportOffline() {
  if (!forcedOffline) { forcedOffline = true; emit(); }
}

/** A request succeeded, so the connection is real whatever the browser thinks. */
export function reportOnline() {
  if (forcedOffline) { forcedOffline = false; emit(); }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { forcedOffline = false; emit(); flushQueue(); });
  window.addEventListener('offline', emit);
}

// ── The write queue ─────────────────────────────────────────────────────────
/**
 * Queue one write for replay. `label` is what the officer sees in the pending
 * list, so it must read as their action ("Diary entry — FIR 144…"), not as a
 * URL.
 */
export async function queueWrite({ url, body, label, caseMasterId }) {
  const entry = {
    url,
    body,
    label: label || 'Pending change',
    caseMasterId: caseMasterId || null,
    // When the officer actually did the work. The server records when it was
    // received; both belong in the audit trail, and conflating them would put a
    // false time against a police record.
    authoredAt: Date.now(),
    attempts: 0,
  };
  await tx('readwrite', (s) => s.add(entry));
  notifyQueue();
  requestBackgroundSync();
  return entry;
}

export async function pendingWrites() {
  return tx('readonly', (s) => new Promise((res, rej) => {
    const r = s.getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  }));
}

export async function pendingCount() {
  return (await pendingWrites()).length;
}

const queueListeners = new Set();
export function onQueueChange(fn) {
  queueListeners.add(fn);
  return () => queueListeners.delete(fn);
}
async function notifyQueue() {
  const n = await pendingCount().catch(() => 0);
  queueListeners.forEach((fn) => { try { fn(n); } catch { /* ignore */ } });
}

let flushing = false;
/**
 * Replay queued writes oldest-first. Stops at the first failure so ordering is
 * preserved — two diary entries must land in the sequence the officer wrote
 * them, since Case Diary serial numbers are assigned on arrival.
 */
export async function flushQueue() {
  if (flushing || !navigator.onLine) return { sent: 0, failed: 0 };
  flushing = true;
  let sent = 0; let failed = 0;
  try {
    const items = (await pendingWrites()).sort((a, b) => a.authoredAt - b.authoredAt);
    for (const item of items) {
      try {
        const res = await fetch(item.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...item.body, offlineAuthoredAt: item.authoredAt }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await tx('readwrite', (s) => s.delete(item.id));
        sent += 1;
        reportOnline();
      } catch {
        // Leave it queued and stop: a later entry must not overtake an earlier
        // one. A transient failure retries on the next reconnect.
        failed += 1;
        reportOffline();
        break;
      }
    }
  } finally {
    flushing = false;
    notifyQueue();
  }
  return { sent, failed };
}

/** Discard one queued write (the officer chose to abandon it). */
export async function discardWrite(id) {
  await tx('readwrite', (s) => s.delete(id));
  notifyQueue();
}

function requestBackgroundSync() {
  // Background Sync replays the queue even if the tab is closed, but it is
  // Chromium-only. Everywhere else the 'online' listener above covers it, so
  // this is an upgrade rather than a dependency.
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready
    .then((reg) => reg.sync && reg.sync.register('sentinel-flush'))
    .catch(() => { /* unsupported or denied — the online listener still fires */ });
}

// ── Sign-out ────────────────────────────────────────────────────────────────
/**
 * Drop every cache and queued write. Called before the Catalyst sign-out
 * redirect so a shared machine keeps nothing from the previous officer.
 * Anything still queued is lost — the caller warns first.
 */
export async function wipeOfflineData() {
  try { await tx('readwrite', (s) => s.clear()); } catch { /* nothing stored */ }
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'SENTINEL_WIPE' });
    }
  } catch { /* no worker */ }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('sentinel-')).map((k) => caches.delete(k)));
  } catch { /* Cache API unavailable */ }
}

// ── Registration ────────────────────────────────────────────────────────────
export function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  // Only over HTTPS or localhost; the browser refuses otherwise.
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${process.env.PUBLIC_URL}/sw.js`)
      .then(() => flushQueue())
      .catch(() => { /* registration blocked — the app works exactly as before */ });
  });
}
