import React, { useEffect, useState } from 'react';
import { Lock, WifiOff } from 'lucide-react';
import { signIn } from '../utils/catalyst';

// Shown instead of the app whenever no officer is known on this device: never
// signed in here, signed out, or a session the SDK could not confirm. Offline
// the app only opens for an officer whose profile is still cached from a
// sign-in on this device (sign-out clears it), so a stranger with a dead
// connection gets this screen — not the menus.
export default function SignInRequired() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' || navigator.onLine);

  useEffect(() => {
    // Back online: re-run the auth flow from the top rather than waiting for a click.
    const onOnline = () => window.location.reload();
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return (
    <div className="loading-screen">
      <div className="ra-denied-card">
        <div className="ra-denied-icon">
          {online ? <Lock size={26} strokeWidth={1.8} /> : <WifiOff size={26} strokeWidth={1.8} />}
        </div>
        <h2>{online ? 'Sign in to continue' : 'You are offline'}</h2>
        <p>
          {online
            ? 'We could not confirm your sign-in. Sign in again to open Sentinel.'
            : 'Connect to the internet to sign in. Sentinel will reload when the connection is back.'}
        </p>
        {online && (
          <button type="button" className="ra-denied-btn" onClick={signIn}>
            Sign in
          </button>
        )}
      </div>
    </div>
  );
}
