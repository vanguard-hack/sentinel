import React from 'react';

// Authentic Indian police rank insignia, keyed by Rank.Hierarchy.
//
// Images are vendored under public/insignia/ from Wikimedia Commons (the set
// used by Wikipedia's "Police ranks and insignia of India"):
//   dgp.png      Director_General_of_Police.png — national emblem over
//                crossed sword & baton (worn by both DGP and ADGP)
//   igp.png      Insignia_of_Inspector_General_of_Police_in_India-*.png —
//                star over crossed sword & baton
//   digp.png     Deputy_Inspector_General_of_Police.png — emblem + 3 stars
//   sp.svg       Superintendent_of_Police.svg — emblem + 1 star
//   addl-sp.svg  AddlSP.svg — emblem
//   dysp.svg     Assistant_Superintendent_of_Police.svg — 3 stars (the
//                ASP/DySP shoulder device is the same)
//   pi.svg       Inspector.svg — 3 stars + red/blue ribbon
//   psi.svg      Sub-Inspector.svg — 2 stars + ribbon
//   asi.svg      Assistant_Sub-Inspector.svg — 1 star + ribbon
//   hc.png       Head_Constable.png — yellow stripes
//   pc.png       Constable.png — plain sleeve chevron
const FILES = {
  1: 'dgp.png',
  2: 'dgp.png',
  3: 'igp.png',
  4: 'digp.png',
  5: 'sp.svg',
  6: 'addl-sp.svg',
  7: 'dysp.svg',
  8: 'pi.svg',
  9: 'psi.svg',
  10: 'asi.svg',
  11: 'hc.png',
  12: 'pc.png',
};

export default function RankInsignia({ hierarchy, size = 28, title }) {
  const file = FILES[Number(hierarchy)];
  if (!file) return null;
  return (
    <img
      className="pp-insignia"
      src={`${process.env.PUBLIC_URL}/insignia/${file}`}
      height={size}
      alt={title || 'Rank insignia'}
      title={title}
      loading="lazy"
    />
  );
}
