// Catalyst Web SDK v4 is loaded in public/index.html via two scripts:
//   <script src="https://static.zohocdn.com/catalyst/sdk/js/4.6.2/catalystWebSDK.js"></script>
//   <script src="/__catalyst/sdk/init.js"></script>
// The second script is served from THIS deployment's Catalyst origin and binds
// the SDK to the correct project + data centre. There is NO catalyst.initialize()
// in v4 — you call window.catalyst.auth / window.catalyst.userManagement directly.

export const getCatalyst = () =>
  (typeof window !== 'undefined' && window.catalyst) ? window.catalyst : null;

// Kept for call-site compatibility; v4 needs no explicit init step.
export const initCatalyst = () => getCatalyst();

// Auth pages live on the SAME origin that serves the app (where the session
// cookie is), whatever the project's domain is — derive it instead of hardcoding.
const CATALYST_BASE = `${typeof window !== 'undefined' ? window.location.origin : ''}/__catalyst/auth`;

export const AUTH_URLS = {
  login:         `${CATALYST_BASE}/login`,
  signup:        `${CATALYST_BASE}/signup`,
  resetPassword: `${CATALYST_BASE}/reset-password`,
};

// Set the moment the officer asks to sign out, cleared only by asking to sign
// in. While it is set the app shows the signed-out screen whatever the SDK or
// the cached profile claim, so a logout that half-landed can never leave the
// app looking signed in while the server refuses every request.
const SIGNED_OUT_KEY = 'sentinel_signed_out';
export const signedOutMark = () => { try { return localStorage.getItem(SIGNED_OUT_KEY); } catch { return null; } };
export const setSignedOutMark = (v) => { try { localStorage.setItem(SIGNED_OUT_KEY, v); } catch { /* storage blocked */ } };
const clearSignedOutMark = () => { try { localStorage.removeItem(SIGNED_OUT_KEY); } catch { /* storage blocked */ } };

// The server is the authority on the session: true = live, false = it answered
// 401, null = could not tell (offline, cold start, outage).
export const serverSession = async () => {
  try {
    const r = await fetch('/server/rag/access/me', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 401) return false;
    return r.ok ? true : null;
  } catch { return null; }
};

export const signIn        = () => { clearSignedOutMark(); window.location.href = AUTH_URLS.login; };
export const signUp        = () => { window.location.href = AUTH_URLS.signup; };
export const resetPassword = () => { window.location.href = AUTH_URLS.resetPassword; };

/* Sign out.
 *
 * catalyst.auth.signOut(redirectURL):
 *   - takes a STRING redirect URL (not an object)
 *   - returns NO promise — do not await it
 *   - clears the session cookie ITSELF and then performs the redirect
 *
 * The session cookie is HttpOnly, so nothing on this page can clear it. Only
 * that SDK call can, which makes it the one step that must not be interrupted.
 *
 * IT USED TO BE INTERRUPTED. A 1.2s timer forced `window.location` to the login
 * page "so sign-out never feels stuck". On any connection where clearing the
 * cookie took longer than that, the timer won: it cancelled the in-flight
 * logout and landed on the login page with the session still valid — so
 * Catalyst saw a live session and sent the officer straight back into the app.
 * Sign-out appeared to do nothing, and the failure got MORE likely the worse
 * the connection was. A fallback that navigates away from the logout request
 * cannot complete a logout.
 *
 * THAT WAS NOT THE WHOLE STORY. Fixing the timer left sign-out still doing
 * nothing, because the URL the SDK was building was itself rejected: SDK 4.0.0
 * emits the legacy global-logout shape and Zoho IAM answers it with a
 * `?error=invalid_portal` dead end, so the cookie survived a logout that
 * "succeeded". The real fix is the SDK version pinned in public/index.html —
 * nothing in this file could have repaired a logout URL it does not construct.
 * Kept as a note because the symptom (a spinner, then the app again) is
 * identical for both causes, and the timing one is the tempting explanation.
 *
 * The redirect target is this deployment's own index (the documented value for
 * a Web Client mounted at /app), not the Catalyst login page. After the cookie
 * is gone the app's own auth check runs and sends an unauthenticated visitor to
 * login — one path in and out of the session instead of two. */
const APP_HOME = () =>
  `${window.location.origin}${process.env.PUBLIC_URL || ''}/index.html`;

// Long enough that it cannot race a logout that is simply slow; short enough
// that a genuinely dead SDK call does not strand the officer on a spinner. It
// reloads the app rather than jumping to the login page: if the cookie went,
// the app redirects to login by itself; if it did not, they are still signed in
// and can try again, which is the truth rather than a login page that bounces.
const SIGNOUT_ESCAPE_MS = 8000;

// Two sessions exist, and both must end. The app's own cookie is cleared by
// /accounts/p/<ZAID>/logout on this origin — the URL the SDK builds. But the
// Zoho login itself lives on auth_domain (accounts.zohoportal.in), and while
// THAT session survives, the login page signs the officer straight back in
// without asking for a password. So log out there first, and let it hand over
// to this origin's logout, which returns to the app. ZAID and auth_domain differ
// between Development and Production, so both come from this deployment's
// init.js, never hardcoded.
export const logoutUrlFrom = (initJs, home) => {
  const src = String(initJs || '');
  const zaid = /zaid\s*:\s*"(\d+)"/.exec(src);
  if (!zaid) return null;
  const local = `${window.location.origin}/accounts/p/${zaid[1]}/logout?servicename=ZohoCatalyst&serviceurl=${encodeURIComponent(home)}`;
  const domain = /auth_domain\s*:\s*"(https:\/\/[^"]+)"/.exec(src);
  return domain ? `${domain[1]}/accounts/p/${zaid[1]}/logout?servicename=ZohoCatalyst&serviceurl=${encodeURIComponent(local)}` : local;
};

export const signOut = async () => {
  if (!signedOutMark()) setSignedOutMark('1');
  const home = APP_HOME();
  let url = null;
  try {
    const r = await fetch('/__catalyst/sdk/init.js', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    url = logoutUrlFrom(await r.text(), home);
  } catch { /* unreachable — fall back to the SDK below */ }
  if (url) { window.location.href = url; return; }
  const cat = getCatalyst();
  if (cat && cat.auth && typeof cat.auth.signOut === 'function') {
    try {
      setTimeout(() => { window.location.href = home; }, SIGNOUT_ESCAPE_MS);
      cat.auth.signOut(home);
      return;
    } catch { /* SDK present but unbound */ }
  }
  window.location.href = `${window.location.origin}/__catalyst/auth/login`;
};

// Race a promise against a timeout so a hung/unconfigured SDK can't block the app.
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);

// Best-effort fetch of the current user's profile via the v4 user-management
// component. getCurrentProjectUser() resolves to { content: { first_name,
// last_name, email_id, ... } }. Returns null if the SDK is unavailable, the
// call times out, or no session exists. Never throws, never hangs.
export const getCurrentUser = async (timeoutMs = 4000) => {
  try {
    const cat = getCatalyst();
    if (!cat) return null;
    // An SDK core that loaded but never got its project/DC binding (offline,
    // /__catalyst/sdk/init.js is same-origin and explicitly network-only —
    // see NEVER_CACHE in public/sw.js) can throw HERE, synchronously, rather
    // than reject a promise. Inside this try, that still resolves to null.
    const um = typeof cat.userManagement === 'function' ? cat.userManagement() : cat.userManagement;
    if (!um || typeof um.getCurrentProjectUser !== 'function') return null;
    const res = await withTimeout(um.getCurrentProjectUser(), timeoutMs);
    return res?.content ?? res ?? null;
  } catch {
    return null;
  }
};
