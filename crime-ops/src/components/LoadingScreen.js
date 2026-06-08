import React from 'react';

export default function LoadingScreen({ message = 'Initializing Sentinel…' }) {
  return (
    <div className="loading-screen">
      <div className="loading-inner">
        <div className="loading-shield">
          <svg width="56" height="64" viewBox="0 0 56 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M28 2L4 12V30C4 44.5 14.5 57.5 28 62C41.5 57.5 52 44.5 52 30V12L28 2Z"
              fill="url(#loadShieldGrad)"
              stroke="url(#loadShieldStroke)"
              strokeWidth="1.5"
            />
            <defs>
              <linearGradient id="loadShieldGrad" x1="28" y1="2" x2="28" y2="62" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#1D4ED8" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#0A1628" stopOpacity="0.9" />
              </linearGradient>
              <linearGradient id="loadShieldStroke" x1="4" y1="2" x2="52" y2="62" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#3B82F6" />
                <stop offset="100%" stopColor="#1D4ED8" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div className="loading-spinner" />
        <p className="loading-message">{message}</p>
      </div>
    </div>
  );
}
