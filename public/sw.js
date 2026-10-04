/* Reality OS service worker — offline app shell, honest live data.
 *
 * Caching strategy (deliberate):
 *  - App shell (/, /index.html, logo, manifest, icon font): precached at
 *    install; navigations are network-first with fallback to the cached
 *    shell, so the UI opens offline.
 *  - Same-origin static assets (/assets/*, /fonts/*, /models/*, …):
 *    stale-while-revalidate — fast from cache, refreshed in background, so a
 *    new deploy's hashed bundle never strands on an old copy.
 *  - /api/* : NEVER cached or served by this worker (network-only
 *    passthrough). Live-data freshness belongs to the providers' own
 *    TTL/stale-fallback machinery, which labels staleness explicitly.
 *    Offline, /api/* fetches fail and the UI shows its normal error states —
 *    no fake "fresh" data is ever manufactured client-side.
 *  - Cross-origin (Google Fonts etc.): passthrough, never cached.
 *
 * Bump CACHE_VERSION whenever the precached shell list changes.
 */
const CACHE_VERSION = 'satwq-reality-os-v1';
const SHELL_CACHE = `satwq-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `satwq-runtime-${CACHE_VERSION}`;
const RUNTIME_MAX_ENTRIES = 150;

const SHELL_URLS = [
  '/',
  '/index.html',
  '/logo.svg',
  '/manifest.webmanifest',
  '/fonts/material-symbols-outlined-subset.woff2',
];

const isApiRequest = (url) => url.pathname.startsWith('/api/');
const isSameOrigin = (url) => url.origin === self.location.origin;
const isCacheableDestination = (request) =>
  ['script', 'style', 'font', 'image', 'manifest'].includes(request.destination);

async function trimRuntimeCache() {
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    const keys = await cache.keys();
    if (keys.length > RUNTIME_MAX_ENTRIES) {
      // Cache keys are insertion-ordered: evict the oldest first.
      await cache.delete(keys[0]);
    }
  } catch {
    /* cache unavailable — nothing to trim */
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        const copy = response.clone();
        cache.put(request, copy).then(trimRuntimeCache).catch(() => {});
      }
      return response;
    })
    .catch(() => cached || Response.error());
  return cached || network;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        // Best-effort per URL: one missing asset must not fail the install.
        Promise.allSettled(SHELL_URLS.map((url) => cache.add(url)))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Live data: always the network, never the cache (honesty rule above).
  if (isApiRequest(url)) return;

  // Navigations: network first, cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .match('/index.html')
          .then((hit) => hit || caches.match('/'))
      )
    );
    return;
  }

  // Same-origin static: stale-while-revalidate. Everything else passes through.
  if (isSameOrigin(url) && isCacheableDestination(request)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
