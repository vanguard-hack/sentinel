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
