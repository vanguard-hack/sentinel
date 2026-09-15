// Client-side audit capture. Events are queued locally and flushed to the
// rag function in small batches (timer + page-hide beacon) so navigation is
// never blocked. The server enriches each batch with the caller's verified
// identity, IP, geo-location and IST timestamp before storing it.

// Bland path on purpose — "/audit/log"-style URLs match ad-blocker privacy
// lists and the requests die silently in the browser.
const FLUSH_URL = '/server/rag/access/record';
const FLUSH_MS = 4000;
const MAX_QUEUE = 200;

let identity = { email: '', name: '' };
let queue = [];
let timer = null;
let lastError = '';

const SESSION_KEY = 'sentinel_audit_session';
function sessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return 'anon';
  }
}

export function setAuditIdentity(next) {
  identity = { ...identity, ...next };
}

function flush(useBeacon) {
  if (!queue.length) return Promise.resolve({ ok: true, sent: 0 });
  const events = queue.splice(0, 50);
  const body = JSON.stringify({ events });

  if (useBeacon && navigator.sendBeacon) {
    const ok = navigator.sendBeacon(FLUSH_URL, new Blob([body], { type: 'application/json' }));
    if (!ok && queue.length + events.length <= MAX_QUEUE) queue.unshift(...events);
    return Promise.resolve({ ok, sent: events.length });
  }

  return fetch(FLUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      lastError = '';
      return { ok: true, sent: events.length };
    })
    .catch((e) => {
      // Failed sends go back on the queue (bounded) so a transient failure
      // doesn't lose the trail; the error is kept for the self-test UI.
      lastError = e?.message || 'network error';
      if (queue.length + events.length <= MAX_QUEUE) queue.unshift(...events);
      return { ok: false, error: lastError };
    });
}

// Force an immediate flush and report the outcome — used by the audit page's
// capture self-test so a blocked request becomes visible instead of silent.
export function flushNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  return flush(false);
}

export const auditLastError = () => lastError;

export function logAudit(action, feature, detail = '') {
  queue.push({
    ts: Date.now(),
    action,
    feature,
    detail,
    path: window.location.pathname.replace(/^\/app/, '') || '/',
    session: sessionId(),
    email: identity.email,
    name: identity.name,
  });
  if (queue.length >= 20) flush(false);
  else if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      flush(false);
    }, FLUSH_MS);
  }
}

// Whatever is still queued when the tab hides must go out as a beacon —
// fetch() started during unload is routinely cancelled by the browser.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
}
