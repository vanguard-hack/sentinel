import React from 'react';

// Epaulette-style rank insignia for the 12-rank Karnataka Police ladder,
// keyed by Rank.Hierarchy. Simplified from the real shoulder devices:
//   DGP/ADGP  national emblem over crossed sword & baton
//   IGP       star over crossed sword & baton
//   DIGP      national emblem over three stars
//   SP        national emblem over one star
//   Addl. SP  national emblem
//   DySP      three stars
//   PI        three stars + red/blue ribbon base
//   PSI       two stars + ribbon
//   ASI       one star + ribbon
//   HC        three chevrons
//   PC        plain epaulette

const GOLD = '#d9b64a';
const NAVY = '#2b3550';
const RED = '#b3402f';
const BLUE = '#31549b';

const starPoints = (cx, cy, r = 4.2) => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
};

const Star = ({ cy, r }) => <polygon points={starPoints(18, cy, r)} fill={GOLD} />;

// Abstracted Ashoka capital: three heads over the abacus, chakra beneath.
const Emblem = ({ cy }) => (
  <g fill={GOLD}>
    <circle cx="14" cy={cy - 2} r="1.9" />
    <circle cx="18" cy={cy - 3.2} r="2.1" />
    <circle cx="22" cy={cy - 2} r="1.9" />
    <rect x="11.5" y={cy + 0.6} width="13" height="2.4" rx="0.6" />
    <circle cx="18" cy={cy + 5.6} r="1.7" fill="none" stroke={GOLD} strokeWidth="1.1" />
  </g>
);

const SwordBaton = ({ cy }) => (
  <g stroke={GOLD} strokeWidth="1.6" strokeLinecap="round">
    <line x1="10.5" y1={cy + 7.5} x2="25.5" y2={cy - 7.5} />
    <line x1="25.5" y1={cy + 7.5} x2="10.5" y2={cy - 7.5} />
    <line x1="22.6" y1={cy + 6.8} x2="27" y2={cy + 3.6} strokeWidth="1.3" />
    <circle cx="10.5" cy={cy + 7.5} r="1.2" fill={GOLD} strokeWidth="0" />
  </g>
);

const Ribbon = ({ y }) => (
  <g>
    <rect x="10" y={y} width="5.4" height="5" fill={RED} />
    <rect x="15.4" y={y} width="5.2" height="5" fill={BLUE} />
    <rect x="20.6" y={y} width="5.4" height="5" fill={RED} />
    <rect x="10" y={y} width="16" height="5" fill="none" stroke={GOLD} strokeWidth="0.8" />
  </g>
);

const Chevrons = () => (
  <g stroke={GOLD} strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
    {[15, 23, 31].map((y) => (
      <polyline key={y} points={`10.5,${y} 18,${y + 5.5} 25.5,${y}`} />
    ))}
  </g>
);

const DEVICES = {
  1: <><Emblem cy={15} /><SwordBaton cy={32} /></>,
  2: <><Emblem cy={15} /><SwordBaton cy={32} /></>,
  3: <><Star cy={15} r={4.4} /><SwordBaton cy={32} /></>,
  4: <><Emblem cy={14} /><Star cy={26} r={3.4} /><polygon points={starPoints(13, 35, 3.4)} fill={GOLD} /><polygon points={starPoints(23, 35, 3.4)} fill={GOLD} /></>,
  5: <><Emblem cy={16} /><Star cy={32} r={4.2} /></>,
  6: <Emblem cy={24} />,
  7: <><Star cy={15} r={3.9} /><Star cy={26} r={3.9} /><Star cy={37} r={3.9} /></>,
  8: <><Star cy={13} r={3.7} /><Star cy={22.5} r={3.7} /><Star cy={32} r={3.7} /><Ribbon y={37.5} /></>,
  9: <><Star cy={16} r={3.9} /><Star cy={27} r={3.9} /><Ribbon y={36} /></>,
  10: <><Star cy={20} r={4.2} /><Ribbon y={33} /></>,
  11: <Chevrons />,
  12: null,
};

export default function RankInsignia({ hierarchy, size = 26, title }) {
  const h = Number(hierarchy);
  return (
    <svg
      width={(size * 36) / 48}
      height={size}
      viewBox="0 0 36 48"
      className="pp-insignia"
      role="img"
      aria-label={title || `Rank insignia ${h}`}
    >
      {title && <title>{title}</title>}
      <rect x="3" y="2" width="30" height="44" rx="7" fill={NAVY} stroke="rgba(217,182,74,0.55)" strokeWidth="1" />
      <circle cx="18" cy="8" r="2" fill="none" stroke={GOLD} strokeWidth="1" />
      {DEVICES[h] || null}
    </svg>
  );
}
