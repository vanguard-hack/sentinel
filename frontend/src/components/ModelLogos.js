import React from 'react';

// Small monochrome provider marks for the model picker — not the official
// brand files, just enough of each shape to tell the three providers apart
// at a glance. currentColor so they inherit the picker's text color.
//
// className is forwarded rather than swallowed: the composer hides these on a
// phone, and a mark that drops the prop cannot be hidden by a stylesheet that
// believes it did — which is exactly how a clock-faced Groq mark ended up
// sitting alone beside the mic there.

export function AnthropicLogo({ size = 14, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M13.3 4h3.1L23 20h-3.4l-1.3-3.4h-6.9L10 20H6.6L13.3 4zm-.4 9.6h4.4L15.1 7.8l-2.2 5.8z"
        fill="currentColor"
      />
      <path d="M6.6 20 4 13.6 8.7 4H5.6L1 15.2z" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

export function ZaiLogo({ size = 14, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor" opacity="0.15" />
      <path d="M7 7h10l-10 10h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function GroqLogo({ size = 14, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none" />
      <path d="M12 7v6l4 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const MODEL_LOGOS = { claude: AnthropicLogo, glm: ZaiLogo, groq: GroqLogo };
