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

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      initCatalyst();
      const currentUser = await getCurrentUser(); // time-boxed, never hangs

      if (cancelled) return;

      if (currentUser) {
        // Confirmed session — show the app
        sessionStorage.removeItem(REDIRECT_GUARD);
        setUser(currentUser);
        setLoading(false);
        return;
      }

      // No confirmed session.
      if (!sessionStorage.getItem(REDIRECT_GUARD)) {
        // First attempt this tab: send the user to Catalyst's hosted login page.
        sessionStorage.setItem(REDIRECT_GUARD, '1');
        catalystSignIn(); // navigates away; keep the loading screen up
        return;
      }

      // We already came back from a login redirect but still can't read the user
      // (SDK couldn't confirm it). Render the app rather than loop — Catalyst only
      // returns here after a successful login.
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const signOut = useCallback(async () => {
    sessionStorage.removeItem(REDIRECT_GUARD);
    await catalystSignOut();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
};
