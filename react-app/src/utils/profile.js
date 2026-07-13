// User profile: editable details + uploaded photo, stored server-side in
// Stratus (via the rag function) and mirrored to localStorage so the avatar
// photo renders instantly everywhere. A window event lets every mounted
// Avatar refresh when the photo changes.

const PHOTO_KEY = 'sentinel-profile-photo';
export const PROFILE_EVENT = 'sentinel-profile-changed';

export const cachedPhoto = () => {
  try { return localStorage.getItem(PHOTO_KEY) || ''; } catch { return ''; }
};

function setCachedPhoto(dataUrl) {
  try {
    if (dataUrl) localStorage.setItem(PHOTO_KEY, dataUrl);
    else localStorage.removeItem(PHOTO_KEY);
  } catch { /* quota */ }
  window.dispatchEvent(new Event(PROFILE_EVENT));
}

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
    if (profile && typeof profile.photo === 'string') setCachedPhoto(profile.photo);
    return profile || {};
  } catch {
    return {};
  }
}

export async function saveProfile(email, profile) {
  if (!email) throw new Error('not signed in');
  // Ship the photo as raw base64 + mime, NOT a data: URI — the Catalyst
  // gateway's resource access policy rejects data-URI payloads on
  // cookie-authenticated requests (403 access_forbidden).
  const { photo, ...rest } = profile;
  const wire = { ...rest };
  if (typeof photo === 'string' && photo.startsWith('data:image/')) {
    const [head, b64] = photo.split(',', 2);
    wire.photoMime = (head.match(/^data:([^;]+)/) || [])[1] || 'image/jpeg';
    wire.photoB64 = b64 || '';
  } else if (photo === null || photo === '') {
    wire.photoB64 = null;
  }
  const res = await fetch('/server/rag/profile/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, profile: wire }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.message || `save failed (HTTP ${res.status})`);
  }
  if ('photo' in profile) setCachedPhoto(profile.photo || '');
  return data.profile || profile;
}

// Downscale an uploaded image to a square ~256px JPEG data URL (keeps the
// stored photo small and fast).
export function fileToAvatarDataUrl(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const s = Math.min(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read image')); };
    img.src = url;
  });
}
