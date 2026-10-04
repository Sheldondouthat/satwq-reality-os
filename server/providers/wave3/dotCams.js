/**
 * DOT weather-cam mesh proxy (keyless).
 *
 * State 511 traffic cameras repurposed as a weather-cam network. Formats
 * vary per state, so each state is a small adapter behind one normalized
 * record: {id, state, name, lat, lon, imageUrl, streamUrl?, updatedAt}.
 *
 * VERIFIED keyless 2026-09-27 (fetched live):
 *  - California (Caltrans): 11 districts ×
 *    https://cwwp2.dot.ca.gov/data/d{n}/cctv/cctvStatusD{nn}.json
 *    (d1–d12 — all 200; d12 verified live 2026-09-27). Still JPEGs at
 *    imageData.static.currentImageURL; recordTimestamp.recordEpoch.
 *  - Iowa (511IA, Iteris CARS): https://iatg.carsprogram.org/cameras_v1/api/cameras
 *    (200, ~500 cams). Stills at views[].videoPreviewUrl; WMP stream at views[].url.
 *
 * SKIPPED / NOT keyless (documented, not failures):
 *  - NY511 GeoRSS (511ny.org/georss) → 302 to /notfound; the endpoint is dead.
 *  - Mass511 (mass511.com) → SPA with no discoverable public camera API.
 *  - 511IA sibling states → per-state CARS gateways not DNS-discoverable
 *    (guessed <xx>atg.carsprogram.org hosts do not resolve).
 *  - WSDOT → requires an (free) access code; keyed, excluded by iron rule.
 *
 * Routes:
 *   GET /api/dot-cams[?state=CA|IA] → {generatedAt, states:[...], count, cameras:[...]}
 *   GET /api/dot-cams/image?u=<url> → 302 redirect to the upstream still
 *     (allow-listed DOT image hosts; browsers fetch the JPEG directly)
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — no node: imports, no WASM).
 */

const CALTRANS_DISTRICTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const caltransUrl = (n) =>
  `https://cwwp2.dot.ca.gov/data/d${n}/cctv/cctvStatusD${String(n).padStart(2, '0')}.json`;
const IOWA_URL = 'https://iatg.carsprogram.org/cameras_v1/api/cameras';

const IMAGE_HOSTS = new Set([
  'cwwp2.dot.ca.gov', // Caltrans stills
  'atmsqf.iowadot.gov', // Iowa DOT snapshots
  'video2.iowadot.gov', // (stream host; still allow-listed for completeness)
]);

const FETCH_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 12 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const COORD_DECIMALS = 5;
const USER_AGENT = 'Gods Eye View (public DOT weather-cam context)';

let cache = null; // {at, payload}
let inflight = null;

async function fetchJsonCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`dotcams_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('dotcams_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

function roundCoord(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** COORD_DECIMALS;
  return Math.round(n * f) / f;
}

/** Normalize one Caltrans cctv record. */
export function normalizeCaltransCctv(cctv) {
  if (!cctv || typeof cctv !== 'object') return null;
  const loc = cctv.location ?? {};
  const imageUrl = cctv.imageData?.static?.currentImageURL ?? null;
  if (!imageUrl) return null;
  const lat = roundCoord(loc.latitude);
  const lon = roundCoord(loc.longitude);
  if (lat === null || lon === null) return null;
  return {
    id: `ca-${loc.district ?? '?'}${cctv.index ?? Math.round(lat * 1e3)}`,
    state: 'CA',
    name: String(loc.locationName ?? 'Caltrans camera'),
    lat,
    lon,
    imageUrl: String(imageUrl),
    streamUrl: cctv.imageData?.streamingVideoURL ?? null,
    inService: String(cctv.inService ?? '') === 'true',
    updatedAt: Number(cctv.recordTimestamp?.recordEpoch) * 1000 || null,
    source: 'Caltrans',
  };
}

/** Normalize one Iowa CARS camera record. */
export function normalizeIowaCamera(cam) {
  if (!cam || typeof cam !== 'object') return null;
  const view = Array.isArray(cam.views) ? cam.views[0] : null;
  const imageUrl = view?.videoPreviewUrl ?? null;
  if (!imageUrl) return null;
  const lat = roundCoord(cam.location?.latitude);
  const lon = roundCoord(cam.location?.longitude);
  if (lat === null || lon === null) return null;
  return {
    id: `ia-${cam.id}`,
    state: 'IA',
    name: String(cam.name ?? 'Iowa DOT camera'),
    lat,
    lon,
    imageUrl: String(imageUrl),
    streamUrl: view?.url ?? null,
    inService: cam.public !== false,
    updatedAt: Number(cam.lastUpdated) || null,
    source: 'Iowa DOT',
  };
}

async function loadSnapshot() {
  const cameras = [];
  const stateResults = [];
  // Caltrans districts in parallel; one dead district must not kill the mesh.
  const districtJobs = CALTRANS_DISTRICTS.map(async (n) => {
    try {
      const body = await fetchJsonCapped(caltransUrl(n));
      const records = Array.isArray(body?.data) ? body.data : [];
      let added = 0;
      for (const item of records) {
        const cam = normalizeCaltransCctv(item?.cctv);
        if (cam && cam.inService) {
          cameras.push(cam);
          added++;
        }
      }
      stateResults.push({ state: 'CA', district: n, cameras: added, ok: true });
    } catch (error) {
      stateResults.push({
        state: 'CA',
        district: n,
        cameras: 0,
        ok: false,
        error: error?.message,
      });
    }
  });
  const iowaJob = (async () => {
    try {
      const body = await fetchJsonCapped(IOWA_URL);
      const records = Array.isArray(body) ? body : [];
      let added = 0;
      for (const item of records) {
        const cam = normalizeIowaCamera(item);
        if (cam) {
          cameras.push(cam);
          added++;
        }
      }
      stateResults.push({ state: 'IA', cameras: added, ok: true });
    } catch (error) {
      stateResults.push({
        state: 'IA',
        cameras: 0,
        ok: false,
        error: error?.message,
      });
    }
  })();
  await Promise.all([...districtJobs, iowaJob]);
  stateResults.sort(
    (a, b) =>
      String(a.state).localeCompare(String(b.state)) ||
      (a.district ?? 0) - (b.district ?? 0),
  );
  return {
    generatedAt: new Date().toISOString(),
    states: stateResults,
    count: cameras.length,
    cameras,
  };
}

async function getSnapshot() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = loadSnapshot().then(
      (payload) => {
        cache = { at: Date.now(), payload };
        inflight = null;
        return payload;
      },
      (error) => {
        inflight = null;
        if (cache) return cache.payload;
        throw error;
      },
    );
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** /api/dot-cams/image?u=<url> — 302 to allow-listed DOT still hosts only. */
export function imageRedirectTarget(rawUrl) {
  try {
    const target = new URL(String(rawUrl));
    if (target.protocol !== 'https:') return null;
    if (!IMAGE_HOSTS.has(target.hostname)) return null;
    return target.toString();
  } catch {
    return null;
  }
}

/** Mount the DOT-cam proxy. Mirrors the nws-alerts provider shape. */
export function dotCamsProxy() {
  async function handler(req, res) {
    req.on?.('close', () => {});
    try {
      const parsed = new URL(req.url ?? '/api/dot-cams', 'http://localhost');
      if (req.method !== 'GET')
        return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
      if (parsed.pathname.endsWith('/image')) {
        const target = imageRedirectTarget(parsed.searchParams.get('u'));
        if (!target)
          return sendJson(
            res,
            403,
            { error: 'dotcams_forbidden_host' },
            'no-store',
          );
        res.writeHead(302, {
          Location: target,
          'Cache-Control': 'public, max-age=60',
        });
        return res.end();
      }
      const payload = await getSnapshot();
      const state = parsed.searchParams.get('state');
      if (state) {
        const wanted = state.toUpperCase();
        const filtered = payload.cameras.filter((c) => c.state === wanted);
        return sendJson(
          res,
          200,
          {
            ...payload,
            count: filtered.length,
            cameras: filtered,
            state: wanted,
          },
          `public, max-age=${Math.floor(CACHE_TTL_MS / 2000)}`,
        );
      }
      sendJson(
        res,
        200,
        payload,
        `public, max-age=${Math.floor(CACHE_TTL_MS / 2000)}`,
      );
    } catch (error) {
      sendJson(
        res,
        error?.status === 502 ? 502 : 500,
        { error: 'dotcams_unavailable', detail: error?.message ?? 'unknown' },
        'no-store',
      );
    } finally {
      req.removeListener?.('close', () => {});
    }
  }

  return {
    name: 'dot-cams',
    configureServer({ middlewares }) {
      middlewares.use('/api/dot-cams', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/dot-cams', handler);
    },
  };
}

export const _dotCamsInternals = {
  caltransUrl,
  CALTRANS_DISTRICTS,
  loadSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
