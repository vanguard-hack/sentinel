let catalystApp = null;

export const initCatalyst = () => {
  try {
    if (window.catalyst) {
      catalystApp = window.catalyst.initialize();
    }
  } catch (e) {
    console.warn('[Sentinel] Catalyst SDK init failed — running in dev mode:', e.message);
  }
  return catalystApp;
};

export const getCatalyst = () => catalystApp;

const CATALYST_BASE = 'https://project-rainfall-60073599957.development.catalystserverless.in/__catalyst/auth';

export const AUTH_URLS = {
  login:         `${CATALYST_BASE}/login`,
  signup:        `${CATALYST_BASE}/signup`,
  resetPassword: `${CATALYST_BASE}/reset-password`,
};

export const signIn         = () => { window.location.href = AUTH_URLS.login; };
export const signUp         = () => { window.location.href = AUTH_URLS.signup; };
export const resetPassword  = () => { window.location.href = AUTH_URLS.resetPassword; };

export const signOut = async () => {
  const app = getCatalyst();
  if (app) {
    await app.auth.signOut({ redirect_url: AUTH_URLS.login });
  } else {
    window.location.href = AUTH_URLS.login;
  }
};

// Race a promise against a timeout so a hung SDK call can never block the app.
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);

// Best-effort fetch of the signed-in user's profile. Returns null if the SDK is
// unavailable, the call times out, or no session exists. Never throws, never hangs.
export const getCurrentUser = async () => {
  const app = getCatalyst();
  if (!app) return null;
  try {
    return await withTimeout(app.auth.getSignedInUser(), 2500);
  } catch {
    return null;
  }
};
