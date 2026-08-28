import React from 'react';

// Catches render/runtime errors in the subtree so a single bad message or
// component can't blank the whole app. Shows a recoverable fallback instead.
//
// A failed code-split chunk is treated separately: after a deploy the old
// hashed chunks stop being served, so a tab opened beforehand can request one
// that no longer exists. Nothing is actually broken — the tab just needs the
// new build — so we say so, and reload once automatically.
const CHUNK_ERROR = /loading chunk|chunkloaderror|failed to fetch dynamically imported module|importing a module script failed/i;
const RELOAD_FLAG = 'sentinel-boundary-reloaded';

const isChunkError = (error) =>
  CHUNK_ERROR.test(`${error?.name || ''} ${error?.message || ''}`);

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, stale: false };
  }

  static getDerivedStateFromError(error) {
    return { error, stale: isChunkError(error) };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Sentinel UI error:', error, info);
    if (!isChunkError(error)) return;
    // Reload once to pick up the current build; the guard stops a reload loop
    // if the chunk is genuinely missing rather than merely stale.
    try {
      if (!sessionStorage.getItem(RELOAD_FLAG)) {
        sessionStorage.setItem(RELOAD_FLAG, '1');
        window.location.reload();
      }
    } catch { /* storage unavailable — leave the manual button */ }
  }

  componentDidMount() {
    // A clean mount means the current build loaded fine; clear the guard so a
    // future stale-chunk error can auto-recover again.
    try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* ignore */ }
  }

  render() {
    if (this.state.error) {
      const { stale } = this.state;
      return (
        <div className="err-boundary">
          <h2>{stale ? 'A new version is available.' : 'Something went wrong on this screen.'}</h2>
          <p>
            {stale
              ? 'This tab was open while the app updated — reloading to pick up the latest version.'
              : 'The rest of the app is fine — reload to continue.'}
          </p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
