/* Reality OS service worker — offline app shell, honest live data.
 *
 * Caching strategy (deliberate):
 *  - App shell (/, /index.html, logo, manifest, icon font): precached at
 *    install; navigations are network-first with fallback to the cached
 *    shell, so the UI opens offline.
 *  - Floor fragments (V5-0: /river.html + /river-floor.js): precached
 *    with the shell, and an offline navigation tries the exact cached
 *    page before the app-shell fallback. The fragment's DATA is never
 *    held here — the river record-cache is page-managed storage
 *    (localStorage, versioned floor-package keys), holding records as
 *    records with their own timestamps; this worker still never
 *    caches or serves /api/* (Packaging Matrix row 3, §2).
 *  - Ghost Tiles floor (Packaging Matrix row 3): the home-region
 *    PMTiles archive + its manifest live in their own versioned cache
 *    (FLOOR_CACHE), beside the river fragment's storage. The archive
 *    is fetched once, SHA-256-verified against the manifest, and only
 *    then cached; a hash or byte-count mismatch is a REFUSAL — the
 *    bytes are never cached, never served, and the refusal is recorded
 *    in the floor status (readable at /floor/floor-status.json, a
 *    worker-generated answer, not a file). Tile reads are HTTP Range
 *    requests served by this worker out of the verified cache entry —
 *    the PMTiles protocol; no tile server exists in the path. The
 *    floor is a built record: it is never badged live anywhere, and
 *    its age is read from the manifest's build timestamp by the page
 *    (public/floor-tiles.js), never from fetch time.
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
const CACHE_VERSION = 'satwq-reality-os-v3';
const SHELL_CACHE = `satwq-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `satwq-runtime-${CACHE_VERSION}`;
const FLOOR_CACHE = `satwq-floor-${CACHE_VERSION}`;
const RUNTIME_MAX_ENTRIES = 150;

const SHELL_URLS = [
  '/',
  '/index.html',
  '/logo.svg',
  '/manifest.webmanifest',
  '/fonts/material-symbols-outlined-subset.woff2',
  // V5-0 floor fragment: the Glen Lyn river page + its pure logic module.
  // Both URL forms: Pages 308-redirects /river.html → /river (clean
  // URL), so the canonical path is precached beside the file path.
  '/river.html',
  '/river',
  '/river-floor.js',
  // Ghost Tiles floor fragment: the home-region tiles page + its pure
  // logic module + the vendored renderer/client libraries. The archive
  // and manifest are NOT precached here — they enter FLOOR_CACHE only
  // through the verified Ghost Tiles path below.
  '/floor.html',
  '/floor',
  '/floor-tiles.js',
  '/floor/vendor/maplibre-gl.js',
  '/floor/vendor/maplibre-gl.css',
  '/floor/vendor/pmtiles.js',
];

/* ---- Ghost Tiles: verified floor archive (Packaging Matrix row 3) ---- */

const FLOOR_MANIFEST_URL = '/floor/floor-manifest.json';
const FLOOR_ARCHIVE_URL = '/floor/home-region.pmtiles';
const FLOOR_ARCHIVE_NAME = 'home-region.pmtiles';
const FLOOR_STATUS_URL = '/floor/floor-status.json';

// In-memory copy of the VERIFIED archive bytes. Invariant: bytes enter
// this memo only from a fresh hash verification or from FLOOR_CACHE,
// where only verified bytes are ever put — unverified bytes have no
// path here. The memo is a speed cache only; FLOOR_CACHE is the record.
let floorBytesMemo = null;
let floorEnsureInFlight = null;

async function ghostSha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Single-range parser (the PMTiles client sends single ranges only).
// Mirrors parseRangeHeader in public/floor-tiles.js; the worker is a
// classic script and cannot import the module, so the logic is held
// in both places and pinned by the same tests.
function ghostParseRange(header, totalBytes) {
  if (typeof header !== 'string' || !Number.isInteger(totalBytes) || totalBytes <= 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;
  let start;
  let end;
  if (first === '') {
    const suffix = Number(last);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalBytes - suffix);
    end = totalBytes - 1;
  } else {
    start = Number(first);
    if (!Number.isFinite(start) || start >= totalBytes) return null;
    end = last === '' ? totalBytes - 1 : Math.min(Number(last), totalBytes - 1);
    if (!Number.isFinite(end) || end < start) return null;
  }
  return { start, end };
}

async function readFloorStatus(cache) {
  try {
    const res = await cache.match(FLOOR_STATUS_URL);
    return res ? await res.json() : null;
  } catch {
    return null;
  }
}

async function writeFloorStatus(cache, status) {
  try {
    await cache.put(
      FLOOR_STATUS_URL,
      new Response(JSON.stringify(status), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
  } catch {
    /* cache unavailable — the refusal still stands in the console */
  }
}

/**
 * Fetch the floor archive once, verify it against the Ghost Tiles
 * manifest (SHA-256 + byte count), and cache it ONLY on a match.
 * On mismatch: REFUSAL — any held copy is dropped, the refusal is
 * recorded in the floor status, and nothing unverified is ever served.
 * Idempotent: a held, verified archive short-circuits.
 */
async function ensureFloor() {
  if (floorEnsureInFlight) return floorEnsureInFlight;
  floorEnsureInFlight = (async () => {
    const cache = await caches.open(FLOOR_CACHE);
    const held = await cache.match(FLOOR_ARCHIVE_URL);
    const prior = await readFloorStatus(cache);
    if (held && prior && prior.state === 'verified') return prior;
    let status;
    try {
      const manifestRes = await fetch(FLOOR_MANIFEST_URL, { cache: 'no-store' });
      if (!manifestRes.ok) throw new Error(`manifest_http_${manifestRes.status}`);
      const manifest = await manifestRes.clone().json();
      const entry = manifest && manifest.files && manifest.files[FLOOR_ARCHIVE_NAME];
      if (
        !entry ||
        typeof entry.sha256 !== 'string' ||
        !Number.isInteger(entry.bytes)
      ) {
        throw new Error('manifest_malformed');
      }
      const archiveRes = await fetch(FLOOR_ARCHIVE_URL, { cache: 'no-store' });
      if (!archiveRes.ok) throw new Error(`archive_http_${archiveRes.status}`);
      const buffer = await archiveRes.arrayBuffer();
      const actual = await ghostSha256Hex(buffer);
      if (buffer.byteLength !== entry.bytes || actual !== entry.sha256) {
        await cache.delete(FLOOR_ARCHIVE_URL);
        floorBytesMemo = null;
        status = {
          state: 'refused',
          reason:
            buffer.byteLength !== entry.bytes
              ? 'byte-count-mismatch'
              : 'sha256-mismatch',
          expectedSha256: entry.sha256,
          actualSha256: actual,
          expectedBytes: entry.bytes,
          actualBytes: buffer.byteLength,
          at: new Date().toISOString(),
        };
        console.error(
          '[ghost-tiles] FLOOR REFUSED — the archive failed verification ' +
            'and was NOT cached or served.',
          status
        );
      } else {
        await cache.put(
          FLOOR_ARCHIVE_URL,
          new Response(buffer, {
            headers: { 'Content-Type': 'application/octet-stream' },
          })
        );
        await cache.put(FLOOR_MANIFEST_URL, manifestRes.clone());
        floorBytesMemo = buffer;
        status = {
          state: 'verified',
          sha256: actual,
          bytes: buffer.byteLength,
          floorBuiltAtUtc:
            typeof manifest.floor_built_at_utc === 'string'
              ? manifest.floor_built_at_utc
              : null,
          verifiedAt: new Date().toISOString(),
        };
        console.info(
          `[ghost-tiles] floor archive verified (sha256 ${actual.slice(0, 12)}…) and cached.`
        );
      }
    } catch (err) {
      // A transient failure must not evict a held, verified floor.
      if (held && prior && prior.state === 'verified') return prior;
      status = {
        state: 'unavailable',
        reason: String((err && err.message) || err),
        at: new Date().toISOString(),
      };
      console.error('[ghost-tiles] floor unavailable:', status.reason);
    }
    await writeFloorStatus(cache, status);
    return status;
  })().finally(() => {
    floorEnsureInFlight = null;
  });
  return floorEnsureInFlight;
}

async function floorStatusResponse() {
  const cache = await caches.open(FLOOR_CACHE);
  const status =
    (await readFloorStatus(cache)) || {
      state: 'absent',
      reason: 'floor not yet verified on this device',
    };
  return new Response(JSON.stringify(status), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * Serve the floor archive from the verified cache entry, honoring
 * Range requests (the PMTiles protocol). If nothing verified is held,
 * run the verify path once; a refusal answers 502 — unverified bytes
 * are never served, not even as a fallback.
 */
async function serveFloorArchive(request) {
  if (!floorBytesMemo) {
    const cache = await caches.open(FLOOR_CACHE);
    const stored = await cache.match(FLOOR_ARCHIVE_URL);
    if (stored) {
      floorBytesMemo = await stored.arrayBuffer();
    } else {
      const status = await ensureFloor();
      if (status.state !== 'verified' || !floorBytesMemo) {
        return new Response(
          `Ghost Tiles floor unavailable: ${status.state} (${status.reason || 'no verified archive held'})`,
          { status: 502, headers: { 'Content-Type': 'text/plain' } }
        );
      }
    }
  }
  const buffer = floorBytesMemo;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const range = ghostParseRange(request.headers.get('Range'), buffer.byteLength);
  if (!range) {
    return new Response(buffer, { status: 200, headers });
  }
  const slice = buffer.slice(range.start, range.end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${buffer.byteLength}`,
      'Content-Length': String(slice.byteLength),
    },
  });
}

/** The manifest is served from the verified floor cache when held. */
async function serveFloorManifest(request) {
  const cache = await caches.open(FLOOR_CACHE);
  const held = await cache.match(FLOOR_MANIFEST_URL);
  if (held) return held;
  return fetch(request);
}

/* ---- App shell (unchanged strategy) ---- */

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
  // Ghost Tiles: fetch + verify + cache the floor archive, best-effort —
  // a floor failure must never fail the shell install; the refusal or
  // unavailability is recorded in the floor status instead.
  event.waitUntil(ensureFloor().catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key !== SHELL_CACHE && key !== RUNTIME_CACHE && key !== FLOOR_CACHE
            )
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

  // Ghost Tiles floor: worker-generated status, the verified archive
  // (Range-served from FLOOR_CACHE), and its manifest. These paths are
  // answered before navigation/static handling — the archive is not a
  // static asset and must never take the stale-while-revalidate path,
  // which would serve unverified bytes.
  if (url.pathname === FLOOR_STATUS_URL) {
    event.respondWith(floorStatusResponse());
    return;
  }
  if (url.pathname === FLOOR_ARCHIVE_URL) {
    event.respondWith(serveFloorArchive(request));
    return;
  }
  if (url.pathname === FLOOR_MANIFEST_URL) {
    event.respondWith(serveFloorManifest(request));
    return;
  }

  // Navigations: network first; offline, the exact cached page when
  // one exists (floor fragments), else the cached app shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .match(url.pathname)
          .then((hit) => hit || caches.match('/index.html'))
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
