// geoLocate(): location string + the "does this request look anonymised"
// vpn flag layered onto the same ip-api.com call the audit trail already
// makes for geolocation. Run: node functions/rag/geolocate.test.js

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// geoLocate lives inside index.js's module scope — extracted from the real
// source the same way router.test.js/slash.test.js do, rather than
// reimplementing it, so this exercises the actual implementation.
const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
const grabFn = (name) => {
  const i = src.indexOf(`async function ${name}(`);
  if (i < 0) throw new Error('missing function ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
};

// eslint-disable-next-line no-new-func
const buildGeoLocate = () => new Function(
  'fetch', 'AbortSignal',
  'const geoCache = new Map();\n' + grabFn('geoLocate') + '\nreturn geoLocate;'
);

const originalFetch = global.fetch;
function fakeAbortSignal() {
  return { timeout: () => undefined };
}

(async () => {
  // ── Private/unknown IPs short-circuit — no network call at all ──────────
  let calls = 0;
  const geoLocate1 = buildGeoLocate()(async () => { calls++; throw new Error('should not fetch'); }, fakeAbortSignal());
  for (const ip of ['10.1.2.3', '192.168.0.5', '172.16.0.1', '127.0.0.1', '::1', '']) {
    const r = await geoLocate1(ip);
    check(`private/empty IP "${ip}" short-circuits to {location:'', vpn:false}`,
      r.location === '' && r.vpn === false);
  }
  check('no fetch was made for any private/empty IP', calls === 0);

  // ── proxy:true → vpn:true ────────────────────────────────────────────────
  const geoLocate2 = buildGeoLocate()(
    async () => ({ json: async () => ({ status: 'success', city: 'Berlin', regionName: 'Berlin', country: 'Germany', proxy: true, hosting: false }) }),
    fakeAbortSignal()
  );
  const r2 = await geoLocate2('185.220.101.45');
  check('proxy:true alone sets vpn:true', r2.vpn === true);
  check('location is still composed normally', r2.location === 'Berlin, Berlin, Germany');

  // ── hosting:true (proxy:false) → vpn:true ────────────────────────────────
  const geoLocate3 = buildGeoLocate()(
    async () => ({ json: async () => ({ status: 'success', city: 'Mumbai', regionName: 'Maharashtra', country: 'India', proxy: false, hosting: true }) }),
    fakeAbortSignal()
  );
  const r3 = await geoLocate3('1.2.3.4');
  check('hosting:true alone also sets vpn:true (datacenter/VPS is an anonymisation signal too)', r3.vpn === true);

  // ── both false → vpn:false ───────────────────────────────────────────────
  const geoLocate4 = buildGeoLocate()(
    async () => ({ json: async () => ({ status: 'success', city: 'Bengaluru', regionName: 'Karnataka', country: 'India', proxy: false, hosting: false }) }),
    fakeAbortSignal()
  );
  const r4 = await geoLocate4('4.5.6.7');
  check('an ordinary residential/ISP IP gets vpn:false', r4.vpn === false);

  // ── network failure fails soft, never throws ─────────────────────────────
  const geoLocate5 = buildGeoLocate()(async () => { throw new Error('network down'); }, fakeAbortSignal());
  let threw = false;
  let r5;
  try { r5 = await geoLocate5('8.8.8.8'); } catch { threw = true; }
  check('a fetch failure fails soft to {location:\'\', vpn:false} instead of throwing', !threw && r5.location === '' && r5.vpn === false);

  // ── caching: a second lookup for the same IP does not re-fetch ──────────
  let fetchCount = 0;
  const geoLocate6 = buildGeoLocate()(
    async () => { fetchCount++; return { json: async () => ({ status: 'success', city: 'X', regionName: 'Y', country: 'Z', proxy: true, hosting: false }) }; },
    fakeAbortSignal()
  );
  await geoLocate6('9.9.9.9');
  await geoLocate6('9.9.9.9');
  check('the second lookup for the same IP is served from cache, not a second fetch', fetchCount === 1);

  global.fetch = originalFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
