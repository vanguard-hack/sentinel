// Central data store — ALL map data is loaded from the Zoho Catalyst Stratus
// bucket 'map-data' (the bucket is the SOLE source; there is no local fallback).
// Components read H.* / CRIME.* / STATE.STATE_INFO / DISTRICT.data at call/render
// time; the Crime Map is gated on refreshAllData() resolving successfully, so the
// data is always present by the time anything reads it.
//
// Bucket files (each needs a public GetObject rule + CORS for the app origin;
// the .js ones served as text/javascript):
//   policeHierarchy.js, crimeData2025.js, stateInfo.js   (ES modules)
//   districtInfo.json                                    (JSON)
const BUCKET = 'https://map-data-development.zohostratus.in/';

// These have to stay NATIVE runtime ESM imports — the URL is only known at
// runtime and webpack must not try to resolve or bundle it.
//
// This was `new Function('u', 'return import(u)')`, which works but forces
// script-src to allow 'unsafe-eval' — and 'unsafe-eval' re-opens the single
// thing the Content Security Policy in public/index.html exists to close, for
// the whole app, to buy one dynamic import. webpackIgnore is the supported
// way to say the same thing to webpack 5 (which CRA 5 uses) without handing
// the page a string-to-code primitive.
const nativeImport = (u) => import(/* webpackIgnore: true */ u);

// Live stores — populated by refreshAllData().
export const H = {};
export const CRIME = {};
export const STATE = {};
export const DISTRICT = { data: null };

const loadModule = async (file, target, requiredKey) => {
  try {
    const m = await nativeImport(BUCKET + file);
    if (m && m[requiredKey]) { Object.assign(target, m); return true; }
  } catch (e) {
    console.warn('[Sentinel] data load failed:', file, e.message);
  }
  return false;
};

const loadJson = async (file, target) => {
  try {
    const r = await fetch(BUCKET + file);
    if (r.ok) { target.data = await r.json(); return true; }
  } catch (e) {
    console.warn('[Sentinel] data load failed:', file, e.message);
  }
  return false;
};

// Resolves true only if every dataset loaded from the bucket.
export async function refreshAllData() {
  const oks = await Promise.all([
    loadModule('policeHierarchy.js', H, 'KARNATAKA_DGP'),
    loadModule('crimeData2025.js', CRIME, 'CRIME_2025'),
    loadModule('stateInfo.js', STATE, 'STATE_INFO'),
    loadJson('districtInfo.json', DISTRICT),
  ]);
  return oks.every(Boolean);
}
