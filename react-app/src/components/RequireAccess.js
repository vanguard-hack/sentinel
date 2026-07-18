import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useAccess } from '../context/AccessContext';
import { canAccess, ROLE_LABELS, FEATURES } from '../utils/access';
import { logAudit } from '../utils/audit';
import LoadingScreen from './LoadingScreen';

// Route guard: renders the feature only when the signed-in user's role is on
// its allow-list; otherwise shows a restricted panel (and audits the attempt).
export default function RequireAccess({ feature, children }) {
  const { role, ready } = useAccess();
  const navigate = useNavigate();
  const allowed = ready && canAccess(role, feature);
  const label = FEATURES.find((f) => f.key === feature)?.label || feature;

  useEffect(() => {
    if (ready && !allowed) logAudit('denied', label, `role=${role}`);
  }, [ready, allowed, label, role]);

  if (!ready) return <LoadingScreen message="Checking access…" />;
  if (allowed) return children;

  return (
    <div className="ra-denied">
      <div className="ra-denied-card">
        <div className="ra-denied-icon"><Lock size={26} strokeWidth={1.8} /></div>
        <h2>Restricted area</h2>
        <p>
          <strong>{label}</strong> is not available to the{' '}
          <strong>{ROLE_LABELS[role] || role}</strong> role. Contact your
          administrator if you need this access — the request has been logged.
        </p>
        <button type="button" className="ra-denied-btn" onClick={() => navigate('/reports')}>
          Back to Home
        </button>
      </div>
    </div>
  );
}
