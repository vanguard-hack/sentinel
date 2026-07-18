import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthContext';
import { fetchMyAccess } from '../utils/access';
import { setAuditIdentity, logAudit } from '../utils/audit';

// App-role layer on top of Catalyst auth. Admin comes straight from the
// Catalyst project role ("App Administrator"); everyone else gets the role +
// rank the admin assigned on the Access & Audit page (server-stored).

const AccessContext = createContext(null);

export function AccessProvider({ children }) {
  const { user } = useAuth();
  const [state, setState] = useState({ role: null, rank: '', ready: false });

  const isAdmin = /admin/i.test(user?.role_details?.role_name || '');

  useEffect(() => {
    let cancelled = false;
    if (!user) return undefined;
    const email = (user.email_id || '').toLowerCase();
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    setAuditIdentity({ email, name });

    (async () => {
      const mine = isAdmin ? { role: 'admin', rank: '' } : await fetchMyAccess(email);
      if (cancelled) return;
      setState({ role: mine.role, rank: mine.rank, ready: true });
      logAudit('session-start', 'Sign in', `role=${mine.role}`);
    })();
    return () => { cancelled = true; };
  }, [user, isAdmin]);

  return (
    <AccessContext.Provider value={{ ...state, isAdmin }}>
      {children}
    </AccessContext.Provider>
  );
}

export const useAccess = () => {
  const ctx = useContext(AccessContext);
  if (!ctx) throw new Error('useAccess must be used inside AccessProvider');
  return ctx;
};
