import React from 'react';

// Catches render/runtime errors in the subtree so a single bad message or
// component can't blank the whole app. Shows a recoverable fallback instead.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Sentinel UI error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="err-boundary">
          <h2>Something went wrong on this screen.</h2>
          <p>The rest of the app is fine — reload to continue.</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
