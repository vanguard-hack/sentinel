import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  initCatalyst,
  getCurrentUser,
  signIn as catalystSignIn,
  signOut as catalystSignOut,
} from '../utils/catalyst';

const AuthContext = createContext(null);

// Marks that we've already bounced this tab to the login page once, so a session
// the SDK can't confirm (e.g. region mismatch) doesn't cause an infinite redirect.
const REDIRECT_GUARD = 'sentinel_auth_redirected';
const USER_CACHE_KEY  = 'sentinel_user';

const readCache  = () => { try { const s = localStorage.getItem(USER_CACHE_KEY); return s ? JSON.parse(s) : null; } catch { return null; } };
const writeCache = (u)  => { try { localStorage.setItem(USER_CACHE_KEY, JSON.stringify(u)); } catch {} };
const clearCache = ()   => { try { localStorage.removeItem(USER_CACHE_KEY); } catch {} };

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      initCatalyst();
      const currentUser = await getCurrentUser(); // time-boxed to 4 s, never hangs

      if (cancelled) return;

      if (currentUser) {
        sessionStorage.removeItem(REDIRECT_GUARD);
        writeCache(currentUser); // persist profile so a slow SDK never loses the name
        setUser(currentUser);
        setLoading(false);
        return;
      }

      if (!sessionStorage.getItem(REDIRECT_GUARD)) {
        sessionStorage.setItem(REDIRECT_GUARD, '1');
        catalystSignIn();
        return;
      }

      // SDK timed out but Catalyst already confirmed login (redirect guard is set).
      // Fall back to the cached profile so the user's name is always visible.
      const cached = readCache();
      if (cached) setUser(cached);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // Defeat Chrome's back/forward cache (bfcache): when the page is restored from
  // it (e.g. pressing Back after sign-out), the auth check above does NOT re-run,
  // so the stale dashboard would be shown. Forcing a fresh load re-runs the auth
  // flow, which redirects a signed-out user to the login page.
  useEffect(() => {
    const onPageShow = (e) => { if (e.persisted) window.location.reload(); };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const signOut = useCallback(() => {
    setSigningOut(true); // immediate feedback — the SDK call below then navigates away
    sessionStorage.removeItem(REDIRECT_GUARD);
    clearCache();
    catalystSignOut(); // SDK clears the session cookie and navigates to login itself
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signingOut, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
};
