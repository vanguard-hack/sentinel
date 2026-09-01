// Action queue — what breaks first, across every open case.
//
// The engine is server-side (functions/rag/statutory.js) and deliberately so:
// the obligations are computed from the full case records, and pulling every
// record into the browser to work them out would be both slow and a wider
// exposure of case data than the page needs.

async function post(url, body) {
  const res = await fetch(`/server/rag/${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const fetchActionQueue = () => post('investigation/actions');

/**
 * Mark an obligation as handled off-system, or reopen it.
 *
 * The note is required on acknowledgement and it is not bureaucracy: the engine
 * reads the record, not the world, so a seizure memo filed on paper looks
 * exactly like one that was never made. The note is what tells a supervisor
 * which of those happened.
 */
export const acknowledgeObligation = (caseMasterId, obligationId, note) =>
  post('investigation/obligation-ack', { caseMasterId, obligationId, note });

export const reopenObligation = (caseMasterId, obligationId) =>
  post('investigation/obligation-ack', { caseMasterId, obligationId, undo: true });

// Severity presentation. Ordered by how bad it is, because the queue's whole
// value is that it sorts itself.
export const SEVERITY = {
  overdue: { label: 'Overdue', tone: 'overdue', rank: 0 },
  critical: { label: 'Critical', tone: 'critical', rank: 1 },
  high: { label: 'High', tone: 'high', rank: 2 },
  medium: { label: 'Medium', tone: 'medium', rank: 3 },
  low: { label: 'Low', tone: 'medium', rank: 4 },
};

export const KIND_LABEL = {
  statutory: 'Statutory deadline',
  physical: 'Evidence will be gone',
  admissibility: 'Admissibility',
  procedural: 'Procedure',
};

/**
 * The countdown, in the words an officer would use.
 *
 * "13 days left" and "4 days overdue" are read at a glance; "remainingDays:
 * -4" is not. A clock that has run out says so in the present tense, because
 * that is what it means — the deadline is not approaching, it has passed.
 */
export function countdown(clock) {
  if (!clock || !Number.isFinite(clock.remainingDays)) return null;
  const d = clock.remainingDays;
  if (d < 0) return { text: `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} overdue`, over: true };
  if (d === 0) return { text: 'Due today', over: true };
  return { text: `${d} day${d === 1 ? '' : 's'} left`, over: false };
}

/** "BNSS 187(3) · CrPC 167(2)" — the new section paired with the familiar one. */
export function citation(authority) {
  if (!authority) return null;
  const primary = `${authority.act} ${authority.section}`;
  return authority.legacy ? `${primary} · ${authority.legacy}` : primary;
}
