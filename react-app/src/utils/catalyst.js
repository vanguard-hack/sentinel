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

export const signIn        = () => { window.location.href = AUTH_URLS.login; };
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

export const signOut = () => {
  const home = APP_HOME();
  const cat = getCatalyst();
  if (cat && cat.auth && typeof cat.auth.signOut === 'function') {
    setTimeout(() => { window.location.href = home; }, SIGNOUT_ESCAPE_MS);
    cat.auth.signOut(home);
    return;
  }
  // No SDK on the page: nothing here can clear an HttpOnly cookie, so hand the
  // browser to Catalyst's own auth origin rather than pretending to sign out.
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
export const getCurrentUser = async () => {
  const cat = getCatalyst();
  if (!cat) return null;
  const um = typeof cat.userManagement === 'function' ? cat.userManagement() : cat.userManagement;
  if (!um || typeof um.getCurrentProjectUser !== 'function') return null;
  try {
    const res = await withTimeout(um.getCurrentProjectUser(), 4000);
    return res?.content ?? res ?? null;
  } catch {
    return null;
  }
};
