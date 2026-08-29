// User profile: editable text details stored server-side in Stratus (via the
// rag function). (Photo upload was removed — avatars are always initials.)

export async function getProfile(email) {
  if (!email) return {};
  try {
    const res = await fetch('/server/rag/profile/get', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) return {};
    const { profile } = await res.json();
    return profile || {};
  } catch {
    return {};
  }
}

export async function saveProfile(email, fields) {
  if (!email) throw new Error('not signed in');
  const res = await fetch('/server/rag/profile/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, profile: { ...fields } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `save failed (HTTP ${res.status})`);
  return data.profile || fields;
}

// Split an address at its last "@" so the two halves can be truncated
// independently.
//
// A plain ellipsis over the whole string eats the end first, turning
// "deepujphnson777@gmail.com" into "deepujphnson777@gm…" — which drops the one
// part that says WHICH account is signed in. Splitting lets the local part give
// way instead, so what survives is "deepujp…@gmail.com".
export function splitEmail(email) {
  const addr = String(email || '').trim();
  if (!addr) return null;
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return { user: addr, domain: '' };
  return { user: addr.slice(0, at), domain: addr.slice(at) };
}
