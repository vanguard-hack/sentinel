// The Sentinel brand mark — an interlocking "S" cut from a rounded diamond,
// with two accent notches where the ribbon crosses itself. Pure SVG so it
// scales cleanly from the 20px sidebar chip up to a 512px app icon.
import { useId } from 'react';

export default function SentinelMark({ size = 20, className }) {
  // Unique per instance: a chat renders many marks, and a repeated mask id
  // resolves to the first one in the document, which may be hidden.
  const cut = `sentinel-mark-cut-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <mask id={cut}>
        <rect width="100" height="100" fill="white" />
        <path
          d="M 53,24 C 62,18 76,19 87,27 C 93,33 88,40 74,45 C 68,46 66,46 65,47 C 57,40 53,32 53,24 Z"
          fill="black"
        />
        <path
          d="M 53,24 C 62,18 76,19 87,27 C 93,33 88,40 74,45 C 68,46 66,46 65,47 C 57,40 53,32 53,24 Z"
          fill="black"
          transform="rotate(180 50 50)"
        />
      </mask>
      <path
        d="M 41,10 Q50,3 59,10 L90,41 Q97,50 90,59 L59,90 Q50,97 41,90 L10,59 Q3,50 10,41 Z"
        fill="currentColor"
        mask={`url(#${cut})`}
      />
      <polygon points="93,37 93,50 78,44" fill="currentColor" opacity="0.55" />
      <polygon points="7,63 7,50 22,56" fill="currentColor" opacity="0.55" />
    </svg>
  );
}
