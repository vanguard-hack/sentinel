import React from 'react';

// User avatar: always the user's initials. (Photo upload was removed.)

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

export default function Avatar({ user, size = 32, className = '' }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  return (
    <div className={`avatar ${className}`} style={style} aria-hidden="true">
      <span className="avatar-initials">{initialsOf(user)}</span>
    </div>
  );
}
