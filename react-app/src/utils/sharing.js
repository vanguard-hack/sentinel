// Sending a diary or report to a named officer.
//
// Worth being exact about what this is, because the obvious reading is wrong:
// Sentinel does not scope diaries or reports by owner, so every investigator
// can already open every one. Sharing routes ATTENTION — it puts a specific
// document in a specific officer's inbox with a note and a record of who sent
// it. The wording in the UI says "shared with", never "given access to",
// because the second would be a promise the system does not keep.

const post = async (path, body, what) => {
  const res = await fetch(`/server/rag/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${what} (HTTP ${res.status})`);
  return data;
};

export const fetchOfficers = () => post('share/directory', {}, 'Could not read the officer directory');

export const shareDocument = ({ kind, docId, title, recipients, note }) =>
  post('share/send', { kind, docId, title, recipients, note }, 'Could not share');

export const fetchInbox = () => post('share/inbox', {}, 'Could not read what has been shared with you');

export const fetchDocShares = (kind, docId) =>
  post('share/for-doc', { kind, docId }, 'Could not read who this was shared with');

export const markShareRead = (shareId) => post('share/read', { shareId }, 'Could not update');

export const revokeShare = (shareId, recipient) =>
  post('share/revoke', { shareId, recipient }, 'Could not withdraw');

/**
 * Filter a directory by a typed query.
 *
 * Matches name, address and role, because an officer looking for "Rao" and one
 * looking for "supervisor" are both doing something reasonable, and a picker
 * that only matches the start of a surname is one people give up on.
 */
export function filterOfficers(officers, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return officers || [];
  return (officers || []).filter((o) =>
    `${o.name} ${o.email} ${o.role}`.toLowerCase().includes(q));
}

/** Where a shared document lives, so the inbox can link straight to it. */
export function shareTarget(share) {
  if (!share) return '/';
  return share.kind === 'diary'
    ? `/investigation-diary/${share.docId}`
    : `/report-studio/${share.docId}`;
}

export const KIND_LABEL = { diary: 'Case Diary', report: 'Report' };
