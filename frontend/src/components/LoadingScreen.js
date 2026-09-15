import React from 'react';
import SentinelMark from './SentinelMark';

export default function LoadingScreen({ message = 'Initializing Sentinel…' }) {
  return (
    <div className="loading-screen">
      <div className="loading-inner">
        <div className="loading-shield">
          <SentinelMark size={48} className="loading-mark" />
        </div>
        <div className="loading-spinner" />
        <p className="loading-message">{message}</p>
      </div>
    </div>
  );
}
