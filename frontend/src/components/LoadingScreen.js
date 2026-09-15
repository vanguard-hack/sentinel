import React from 'react';

export default function LoadingScreen({ message = 'Initializing Sentinel…' }) {
  return (
    <div className="loading-screen">
      <div className="loading-inner">
        <div className="loading-shield">
          <svg width="56" height="64" viewBox="0 0 56 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M28 2L4 12V30C4 44.5 14.5 57.5 28 62C41.5 57.5 52 44.5 52 30V12L28 2Z"
              fill="var(--primary)"
              stroke="var(--primary-hover)"
              strokeWidth="1.5"
            />
          </svg>
        </div>
        <div className="loading-spinner" />
        <p className="loading-message">{message}</p>
      </div>
    </div>
  );
}
