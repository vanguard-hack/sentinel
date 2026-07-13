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

// Save text fields, and (separately) upload a new photo as RAW BINARY — the
// Catalyst gateway's resource-access policy 403s arbitrary image data inside a
// scanned JSON body, so the image bytes go up as an octet-stream instead.
// `photo`: { blob, dataUrl } for a new upload · '' to remove · undefined to keep.
export async function saveProfile(email, fields, photo) {
  if (!email) throw new Error('not signed in');

  if (photo && photo.blob) {
    const res = await fetch(`/server/rag/profile/photo?email=${encodeURIComponent(email)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Photo-Mime': photo.blob.type || 'image/jpeg' },
      body: photo.blob,
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || d.message || `photo upload failed (HTTP ${res.status})`);
    }
    setCachedPhoto(photo.dataUrl || '');
  }

  const wire = { ...fields };
  if (photo === '') wire.photoB64 = null; // explicit removal
  const res = await fetch('/server/rag/profile/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, profile: wire }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `save failed (HTTP ${res.status})`);
  if (photo === '') setCachedPhoto('');
  return data.profile || fields;
}

// Downscale an uploaded image to a square ~256px JPEG. Returns { dataUrl, blob }
// — dataUrl for instant preview, blob for the binary upload.
export function fileToAvatar(file, size = 256) {
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
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      canvas.toBlob(
        (blob) => resolve({ dataUrl, blob: blob || null }),
        'image/jpeg',
        0.85
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read image')); };
    img.src = url;
  });
}
