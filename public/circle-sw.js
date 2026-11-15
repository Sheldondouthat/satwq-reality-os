/* The Inner Circle service worker — offline shell with the last fetched data.
   Scope discipline: only Circle paths are handled; every other page passes through. */
const CACHE = 'circle-v1';
const CORE = ['/circle', '/circle.html', '/circle-data.json', '/circle-archive.json', '/registry-health.json', '/board.json', '/circle.webmanifest', '/icons/circle-192.png', '/icons/circle-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (!/^\/(circle|icons\/circle-)/.test(url.pathname)) return;
  if (url.pathname.endsWith('.json')) {
    // data: network first (fresh), cache fallback (offline = last fetched, page stamps its date)
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
  } else {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })));
  }
});
