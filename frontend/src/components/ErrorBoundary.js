import React from 'react';

// Catches render/runtime errors in the subtree so a single bad message or
// component can't blank the whole app. Shows a recoverable fallback instead.
//
// A failed code-split chunk is handled separately: after a deploy the old
// hashed chunks stop being served, so a tab opened beforehand can request one
// that no longer exists. Nothing is broken — the tab just needs the new build —
// so we say so and reload once automatically.
const CHUNK_ERROR = /loading chunk|chunkloaderror|failed to fetch dynamically imported module|importing a module script failed/i;
const RELOAD_FLAG = 'sentinel-boundary-reloaded';

const isChunkError = (error) =>
  CHUNK_ERROR.test(`${error?.name || ''} ${error?.message || ''}`);

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, stale: false, info: null, open: false, copied: false };
  }

  static getDerivedStateFromError(error) {
    return { error, stale: isChunkError(error) };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Sentinel UI error:', error, info);
    this.setState({ info });
    if (!isChunkError(error)) return;
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

  details() {
    const { error, info } = this.state;
    return [
      `${error?.name || 'Error'}: ${error?.message || String(error)}`,
      error?.stack ? `\n${String(error.stack).split('\n').slice(0, 6).join('\n')}` : '',
      info?.componentStack ? `\nComponent stack:${String(info.componentStack).split('\n').slice(0, 8).join('\n')}` : '',
      `\nPage: ${window.location.pathname}`,
    ].filter(Boolean).join('');
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { stale, open, copied } = this.state;
    return (
      <div className="err-boundary">
        <h2>{stale ? 'A new version is available.' : 'Something went wrong on this screen.'}</h2>
        <p>
          {stale
            ? 'This tab was open while the app updated — reloading to pick up the latest version.'
            : 'The rest of the app is fine — reload to continue.'}
        </p>
        <button onClick={() => window.location.reload()}>Reload</button>

        {!stale && (
          <div className="err-details">
            <button
              type="button"
              className="err-details-toggle"
              onClick={() => this.setState((s) => ({ open: !s.open }))}
            >
              {open ? 'Hide' : 'Show'} technical details
            </button>
            {open && (
              <>
                <pre>{this.details()}</pre>
                <button
                  type="button"
                  className="err-details-copy"
                  onClick={() => {
                    try {
                      navigator.clipboard.writeText(this.details());
                      this.setState({ copied: true });
                    } catch { /* clipboard blocked — the text is on screen to copy */ }
                  }}
                >
                  {copied ? 'Copied' : 'Copy details'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  }
}
