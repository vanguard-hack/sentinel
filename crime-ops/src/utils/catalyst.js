// Catalyst Web SDK v4 is loaded in public/index.html via two scripts:
//   <script src="https://static.zohocdn.com/catalyst/sdk/js/4.0.0/catalystWebSDK.js"></script>
//   <script src="/__catalyst/sdk/init.js"></script>
// The second script is served from THIS deployment's Catalyst origin and binds
// the SDK to the correct project + data centre. There is NO catalyst.initialize()
// in v4 — you call window.catalyst.auth / window.catalyst.userManagement directly.

export const getCatalyst = () =>
  (typeof window !== 'undefined' && window.catalyst) ? window.catalyst : null;

// Kept for call-site compatibility; v4 needs no explicit init step.
export const initCatalyst = () => getCatalyst();

const CATALYST_BASE = 'https://project-rainfall-60073599957.development.catalystserverless.in/__catalyst/auth';

export const AUTH_URLS = {
  login:         `${CATALYST_BASE}/login`,
  signup:        `${CATALYST_BASE}/signup`,
  resetPassword: `${CATALYST_BASE}/reset-password`,
};

export const signIn        = () => { window.location.href = AUTH_URLS.login; };
export const signUp        = () => { window.location.href = AUTH_URLS.signup; };
export const resetPassword = () => { window.location.href = AUTH_URLS.resetPassword; };

// catalyst.auth.signOut(redirectURL):
//   - takes a STRING redirect URL (not an object)
//   - returns NO promise — do not await it
//   - itself clears the session cookie AND performs the redirect
// Build the URL from the current origin so the logout request hits the same host
// that owns the (HttpOnly) session cookie. Do NOT override window.location after
// this call — that would cut the SDK off before the cookie is cleared.
export const signOut = () => {
  const redirectURL = `${window.location.protocol}//${window.location.host}/__catalyst/auth/login`;
  const cat = getCatalyst();
  if (cat && cat.auth && typeof cat.auth.signOut === 'function') {
    cat.auth.signOut(redirectURL);
    return;
  }
  // SDK not available (e.g. local dev) — best-effort hard redirect.
  window.location.href = redirectURL;
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
