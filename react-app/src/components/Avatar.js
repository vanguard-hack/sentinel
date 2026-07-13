import React, { useState, useEffect } from 'react';
import { cachedPhoto, PROFILE_EVENT } from '../utils/profile';

// User avatar: shows the Zoho account profile photo when it loads, else the
// initials. The photo is fetched from the Zoho contacts endpoint using the
// signed-in user's ZUID — because the browser already holds the Zoho session
// cookies, the image request authenticates itself. Any failure silently falls
// back to initials, so it never shows a broken image.

export function initialsOf(user) {
  const name =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    user?.email_id ||
    'Officer';
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function photoUrl(user) {
  const zuid = user?.zuid || user?.zaaid || user?.user_id;
  if (!zuid) return null;
  // India DC contacts photo; cache-busted per session so a freshly-updated
  // account photo shows without a hard reload.
  return `https://contacts.zoho.in/file?ID=${zuid}&fs=thumb`;
}

export default function Avatar({ user, size = 32, className = '' }) {
  const [failed, setFailed] = useState(false);
  const [uploaded, setUploaded] = useState(cachedPhoto());

  // Track the uploaded profile photo across the app.
  useEffect(() => {
    const sync = () => setUploaded(cachedPhoto());
    window.addEventListener(PROFILE_EVENT, sync);
    return () => window.removeEventListener(PROFILE_EVENT, sync);
  }, []);

  // Uploaded photo wins; otherwise fall back to the Zoho account photo.
  const url = uploaded || (!failed ? photoUrl(user) : null);

  useEffect(() => { setFailed(false); }, [user?.zuid, user?.user_id, user?.email_id]);

  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };

  return (
    <div className={`avatar ${className}`} style={style} aria-hidden="true">
      {url ? (
        <img
          src={url}
          alt=""
          className="avatar-img"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="avatar-initials">{initialsOf(user)}</span>
      )}
    </div>
  );
}
