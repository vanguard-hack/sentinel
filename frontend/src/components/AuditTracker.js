import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { featureForPath } from '../utils/access';
import { logAudit } from '../utils/audit';

// Logs one audit event per route change — every feature visit (Home,
// Assistant, Personnel, …) lands in the trail without per-page wiring.
export default function AuditTracker() {
  const { pathname } = useLocation();
  useEffect(() => {
    const f = featureForPath(pathname);
    logAudit('view', f?.label || pathname);
  }, [pathname]);
  return null;
}
