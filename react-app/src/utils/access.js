// Role-based access control tied to the KSP rank hierarchy.
//
// Every signed-in user carries an app role (assigned by the admin on the
// Access & Audit page and stored server-side); the admin role itself comes
// from Catalyst's own "App Administrator" project role, so it can never be
// self-assigned. Each feature below declares which roles may open it — the
// sidebar hides what the router blocks, and blocked visits are audit-logged.

export const ROLE_LABELS = {
  admin: 'Admin',
  supervisor: 'Supervisor',
  investigator: 'Investigator',
  analyst: 'Analyst',
  policymaker: 'Policymaker',
};

export const ASSIGNABLE_ROLES = ['investigator', 'analyst', 'supervisor', 'policymaker', 'admin'];

const ALL = ['admin', 'supervisor', 'investigator', 'analyst', 'policymaker'];

// Feature registry: route prefix → allowed roles. Longest prefix wins, and a
// path that matches nothing is open to every signed-in user.
export const FEATURES = [
  { key: 'reports', label: 'Home', path: '/reports', roles: ALL },
  { key: 'incidents', label: 'Incidents', path: '/incidents', roles: ['admin', 'supervisor', 'investigator'] },
  { key: 'crimeMap', label: 'Crime Map', path: '/crime-map', roles: ['admin', 'supervisor', 'investigator', 'analyst'] },
  { key: 'aiAnalytics', label: 'AI Analytics', path: '/ai-analytics', roles: ['admin', 'supervisor', 'analyst', 'policymaker'] },
  { key: 'caseFiles', label: 'Case Files', path: '/case-files', roles: ['admin', 'supervisor', 'investigator'] },
  { key: 'assistant', label: 'Assistant', path: '/assistant', roles: ALL },
  { key: 'personnel', label: 'Personnel', path: '/personnel', roles: ['admin', 'supervisor', 'policymaker'] },
  { key: 'dutyRoster', label: 'Duty Roster', path: '/personnel/roster', roles: ['admin', 'supervisor'] },
  { key: 'orgChart', label: 'Org Chart', path: '/personnel/org-chart', roles: ['admin', 'supervisor', 'policymaker'] },
  { key: 'profile', label: 'Profile', path: '/profile', roles: ALL },
  { key: 'access', label: 'Access & Audit', path: '/access', roles: ['admin'] },
  { key: 'dashboard', label: 'Dashboard', path: '/dashboard', roles: ALL },
];

const byKey = Object.fromEntries(FEATURES.map((f) => [f.key, f]));

export function canAccess(role, featureKey) {
  const f = byKey[featureKey];
  if (!f) return true;
  return f.roles.includes(role);
}

export function featureForPath(pathname) {
  let best = null;
  for (const f of FEATURES) {
    if (pathname === f.path || pathname.startsWith(f.path + '/')) {
      if (!best || f.path.length > best.path.length) best = f;
    }
  }
  return best;
}

// Rank → suggested role (KSP hierarchy 1 = DGP … 12 = PC). The admin can
// always override; this only pre-fills the role when a rank is picked.
// DGP–IGP set policy; DIGP–DySP supervise; PI–ASI investigate; HC/PC assist
// with records and analysis.
export const RANK_ROLE_SUGGEST = {
  DGP: 'policymaker', ADGP: 'policymaker', IGP: 'policymaker',
  DIGP: 'supervisor', SP: 'supervisor', 'Addl. SP': 'supervisor', DySP: 'supervisor',
  PI: 'investigator', PSI: 'investigator', ASI: 'investigator',
  HC: 'analyst', PC: 'analyst',
};

export const RANK_OPTIONS = [
  'DGP', 'ADGP', 'IGP', 'DIGP', 'SP', 'Addl. SP', 'DySP', 'PI', 'PSI', 'ASI', 'HC', 'PC',
];

export async function fetchMyAccess(email) {
  try {
    const res = await fetch('/server/rag/access/me', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.role) return { role: data.role, rank: data.rank || '' };
  } catch {}
  // Fail open to the least-privileged field role so a cold function start
  // never locks a user out of the whole app.
  return { role: 'investigator', rank: '' };
}
