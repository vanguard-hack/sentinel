// Public reference lookups — IFSC branches and postal PIN codes.
//
// WHY THESE TWO ARE SAFE TO CALL AND OTHERS ARE NOT
//
// Sentinel's rule about external services is that police content does not leave
// the country. Every other integration here obeys it by staying inside Zoho's
// Indian data centre, and the assistant's Groq lane is the exception that the
// clearance filter exists to bound.
//
// These two are different in kind, and the difference is worth stating rather
// than assumed. An IFSC code is public routing information printed on every
// cheque book; a PIN code is a postal district. Neither carries a case, a
// person, or anything an officer typed. What travels is "what branch is
// KARB0000123", and the answer is the same for everyone who asks. So these run
// from the browser with no key and no proxy, and no clearance question arises —
// there is nothing to clear.
//
// Both APIs are keyless and free. Both are also somebody else's servers, so
// every call here fails soft: a lookup that does not answer leaves the account
// or the address exactly as it was, and nothing in the page depends on it.

const IFSC_URL = (code) => `https://ifsc.razorpay.com/${encodeURIComponent(code)}`;
const PIN_URL = (pin) => `https://api.postalpincode.in/pincode/${encodeURIComponent(pin)}`;

// An IFSC is 4 letters, a 0, then 6 alphanumerics. Checked before the call so a
// typo costs nothing and a malformed value can never become a URL path.
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const PIN_RE = /^[1-9][0-9]{5}$/;

export const isIfsc = (v) => IFSC_RE.test(String(v || '').toUpperCase().trim());
export const isPin = (v) => PIN_RE.test(String(v || '').trim());

// Answers never change, so they are cached for the session and mirrored to
// localStorage — a branch that resolved yesterday should not cost a round trip
// today, and an officer on a station connection notices.
const CACHE_KEY = 'sentinel.refs.v1';
const memory = new Map();

function readStore() {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function writeStore(obj) {
  try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); } catch { /* private mode */ }
}

function cached(key) {
  if (memory.has(key)) return memory.get(key);
  const hit = readStore()[key];
  if (hit) memory.set(key, hit);
  return hit || null;
}
function remember(key, value) {
  memory.set(key, value);
  const store = readStore();
  store[key] = value;
  // Bounded, because localStorage is small and a lookup cache is not worth
  // filling it — oldest entries go first.
  const keys = Object.keys(store);
  if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete store[k];
  writeStore(store);
}

/**
 * Resolve one IFSC to its bank and branch.
 *
 * Returns null for anything that does not resolve — a wrong code, a dead
 * network, a branch that closed. The caller shows the code as it was.
 */
export async function lookupIfsc(code) {
  const key = `ifsc:${String(code || '').toUpperCase().trim()}`;
  if (!isIfsc(code)) return null;
  const hit = cached(key);
  if (hit) return hit.miss ? null : hit;

  try {
    const res = await fetch(IFSC_URL(String(code).toUpperCase().trim()), {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { remember(key, { miss: true }); return null; }
    const d = await res.json();
    const out = {
      ifsc: d.IFSC || String(code).toUpperCase(),
      bank: d.BANK || '',
      branch: d.BRANCH || '',
      district: d.DISTRICT || '',
      city: d.CITY || '',
      state: d.STATE || '',
      address: d.ADDRESS || '',
    };
    remember(key, out);
    return out;
  } catch {
    // Deliberately not cached as a miss: a timeout says nothing about whether
    // the branch exists, and caching it would make one bad minute permanent.
    return null;
  }
}

/** Resolve several codes, de-duplicated, with failures simply absent. */
export async function lookupIfscMany(codes) {
  const unique = [...new Set((codes || []).map((c) => String(c || '').toUpperCase().trim()).filter(isIfsc))];
  const out = new Map();
  // Small concurrency: this is somebody else's free service, and forty parallel
  // requests from every officer is how a free service stops being one.
  const BATCH = 6;
  for (let i = 0; i < unique.length; i += BATCH) {
    // eslint-disable-next-line no-await-in-loop
    const done = await Promise.all(unique.slice(i, i + BATCH).map((c) => lookupIfsc(c)));
    done.forEach((r, j) => { if (r) out.set(unique[i + j], r); });
  }
  return out;
}

/**
 * Resolve a PIN code to its post offices, district and state.
 *
 * India Post returns an array whose first element carries a Status of
 * 'Success' or 'Error' — an error is a 200, so the status has to be read
 * rather than the HTTP code.
 */
export async function lookupPin(pin) {
  const key = `pin:${String(pin || '').trim()}`;
  if (!isPin(pin)) return null;
  const hit = cached(key);
  if (hit) return hit.miss ? null : hit;

  try {
    const res = await fetch(PIN_URL(String(pin).trim()), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = await res.json();
    const first = Array.isArray(body) ? body[0] : null;
    if (!first || first.Status !== 'Success' || !Array.isArray(first.PostOffice) || !first.PostOffice.length) {
      remember(key, { miss: true });
      return null;
    }
    const offices = first.PostOffice;
    const out = {
      pin: String(pin).trim(),
      district: offices[0].District || '',
      state: offices[0].State || '',
      // Every named locality under this PIN. An FIR address of "Nehru Lane,
      // 560034" is only useful if the localities are there to match against.
      localities: offices.map((o) => o.Name).filter(Boolean).slice(0, 40),
    };
    remember(key, out);
    return out;
  } catch {
    return null;
  }
}

/** For tests and for clearing a stale cache from the console. */
export function _clearRefCache() {
  memory.clear();
  try { window.localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}
