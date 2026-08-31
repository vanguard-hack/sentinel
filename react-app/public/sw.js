/* Sentinel service worker — offline shell for police stations with poor connectivity.
 *
 * WHAT THIS DOES AND DOES NOT CACHE is a data-protection decision, not a
 * performance one, and it is enforced here rather than left to convention:
 *
 *   CACHED   the application itself (JS/CSS/HTML), the India + Karnataka map
 *            geometry, station points and their addresses, rank insignia, and
 *            the hierarchy/crime/state reference data. None of this is personal
 *            data — it is geography, org structure and lookup tables.
 *
 *   NEVER    anything carrying personal data. Every ZCQL read (Data Store) and
 *   CACHED   every /server/rag/* call is network-only, so FIR records, accused,
 *            victims, complainants, statements, the audit trail and assistant
 *            answers never reach disk through this worker. An officer's device
 *            holds no citizen data at rest.
 *
 * The deny path is a positive check, not an omission: requests are only cached
 * when they match an explicit allowlist, so a new endpoint is network-only by
 * default and cannot start persisting personal data by accident.
 */

const VERSION = 'v1';
const SHELL = `sentinel-shell-${VERSION}`;
const REFERENCE = `sentinel-reference-${VERSION}`;
const OURS = [SHELL, REFERENCE];

const BASE = new URL(self.registration.scope).pathname; // "/app/"

// Reference assets worth having before the connection drops. Hashed build
// output is discovered from asset-manifest.json at install time, so this list
// only needs the things whose names are stable.
const STATIC_EXTRA = [
  'maps/india.json',
  'maps/karnataka-police-stations.geojson',
  'manifest.json',
  'favicon-32.png',
  'favicon-64.png',
];

// Cross-origin reference data the Crime Map is gated on. The bucket replies
// Cache-Control: no-store, which stops the HTTP cache but not an explicit
// cache.put — without this the map cannot render offline at all.
const REFERENCE_HOSTS = ['map-data-development.zohostratus.in'];

// The Crime Map is GATED on these four resolving, so caching them only on first
// use meant the map worked offline solely for an officer who had happened to
// open it while online. They are fetched at install instead, so the map is
// available offline after any first visit to the app.
const REFERENCE_BUCKET = 'https://map-data-development.zohostratus.in/';
const REFERENCE_FILES = [
  'policeHierarchy.js', 'crimeData2025.js', 'stateInfo.js', 'districtInfo.json',
].map((f) => REFERENCE_BUCKET + f);

// Personal-data surfaces. Listed for documentation and defence in depth; the
// allowlist below already excludes them.
const NEVER_CACHE = [/\/server\/rag\//, /api\.catalyst\./, /\/__catalyst\//, /accounts\.zoho\./];

const isNeverCache = (url) => NEVER_CACHE.some((re) => re.test(url));

async function precache() {
  const cache = await caches.open(SHELL);
  const urls = new Set([BASE, `${BASE}index.html`]);

  // CRA writes every hashed asset here, so precaching needs no build tooling.
  try {
    const res = await fetch(`${BASE}asset-manifest.json`, { cache: 'no-cache' });
    if (res.ok) {
      const manifest = await res.json();
      (manifest.entrypoints || []).forEach((f) => urls.add(BASE + f));
      Object.values(manifest.files || {}).forEach((f) => {
        // Source maps are never served to users; chunks are fetched on demand
        // and picked up by the runtime cache when first used.
        if (typeof f === 'string' && !f.endsWith('.map')) urls.add(f.startsWith('/') ? f : BASE + f);
      });
    }
  } catch {
    /* offline at install — the runtime cache fills in as pages are used */
  }
  STATIC_EXTRA.forEach((f) => urls.add(BASE + f));
  REFERENCE_FILES.forEach((u) => urls.add(u));

  // Individually, so one 404 cannot fail the whole install.
  const reference = await caches.open(REFERENCE);
  await Promise.all(
    [...urls].map((u) =>
      fetch(u, { cache: 'no-cache' })
        .then((r) => (r.ok ? (REFERENCE_FILES.includes(u) ? reference : cache).put(u, r) : null))
        .catch(() => null)
    )
  );
}

self.addEventListener('install', (e) => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('sentinel-') && !OURS.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

// Signing out must leave nothing behind. The page posts this before the
// Catalyst redirect; the reference caches are dropped along with whatever the
// app cleared from IndexedDB.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SENTINEL_WIPE') {
    e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('sentinel-')).map((k) => caches.delete(k)))));
  }
});

const isReference = (url) =>
  REFERENCE_HOSTS.includes(url.hostname) ||
  (url.origin === self.location.origin &&
    (url.pathname.startsWith(`${BASE}static/`) ||
      url.pathname.startsWith(`${BASE}maps/`) ||
      url.pathname.startsWith(`${BASE}insignia/`) ||
      STATIC_EXTRA.some((f) => url.pathname === BASE + f)));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // writes are queued by the app, not here
  const url = new URL(request.url);
  if (isNeverCache(request.url)) return; // network-only: personal data never lands on disk

  // App shell. Network-first so a deploy is picked up immediately, falling back
  // to the cached shell so the SPA still boots with no connection.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(`${BASE}index.html`, copy));
          return res;
        })
        .catch(async () => (await caches.match(`${BASE}index.html`)) || Response.error())
    );
    return;
  }

  if (!isReference(url)) return; // anything not explicitly allowed stays network-only

  // Hashed build assets are immutable, so cache-first is safe and fastest.
  // Reference data revalidates in the background: the map shows instantly from
  // cache and quietly updates when the network answers.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(REFERENCE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => hit || Response.error());
      return hit || network;
    })
  );
});
