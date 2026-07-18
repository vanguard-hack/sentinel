// Client-side audit capture. Events are queued locally and flushed to the
// rag function in small batches (timer + page-hide beacon) so navigation is
// never blocked. The server enriches each batch with the caller's verified
// identity, IP, geo-location and IST timestamp before storing it.

const FLUSH_URL = '/server/rag/audit/log';
const FLUSH_MS = 4000;

let identity = { email: '', name: '' };
let queue = [];
let timer = null;

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

function payload() {
  return JSON.stringify({ events: queue.splice(0, 50) });
}

function flush(useBeacon) {
  if (!queue.length) return;
  const body = payload();
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon(FLUSH_URL, new Blob([body], { type: 'application/json' }));
    return;
  }
  fetch(FLUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

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
