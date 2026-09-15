// Code-split imports that survive a redeploy.
//
// Each build gives its chunks new hashed filenames and the old ones stop being
// served. A tab that was opened before a deploy therefore asks for a chunk that
// no longer exists, and the dynamic import rejects — which React surfaces as a
// render error and the ErrorBoundary catches ("Something went wrong").
//
// The page itself is fine; it just needs the new build. So on a failed chunk
// fetch we reload once (guarded by sessionStorage so a genuinely broken chunk
// can't put the tab in a reload loop) and let the fresh HTML pull the new
// bundle.
import { lazy } from 'react';

const FLAG = 'sentinel-chunk-reload';

export default function lazyWithReload(factory, key) {
  return lazy(() => factory().then(
    (mod) => {
      try { sessionStorage.removeItem(`${FLAG}:${key}`); } catch { /* private mode */ }
      return mod;
    },
    (err) => {
      let alreadyTried = true;
      try {
        alreadyTried = !!sessionStorage.getItem(`${FLAG}:${key}`);
        if (!alreadyTried) sessionStorage.setItem(`${FLAG}:${key}`, '1');
      } catch { /* storage unavailable — fall through and rethrow */ }
      if (!alreadyTried) {
        window.location.reload();
        // Never settles: the reload replaces this page.
        return new Promise(() => {});
      }
      throw err;
    },
  ));
}
