/**
 * POTA (Parks on the Air) live-spots proxy (keyless).
 *
 * Upstream: https://api.pota.app/spot/ — live activator spots. The spot feed
 * carries park name/reference but NO coordinates, so each unique reference is
 * joined with https://api.pota.app/park/{ref} (lat/lon). Park lookups are
 * cached 24 h; dead refs are cached as null for 5 min so a bad ref can't
 * stampede the upstream.
 *
 * Routes:
 *   GET /api/pota?limit=200&mode=FT8 → {generatedAt, count, withCoords,
 *     spots:[{spotId, spotTime, activator, frequencyKhz, mode, reference,
 *     name, locationDesc, lat, lon}], sources, honesty}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident; final response host is pinned to
 * api.pota.app — no node: imports, no WASM).
 */

const SPOTS_URL = 'https://api.pota.app/spot/';
const PARK_URL = (ref) => `https://api.pota.app/park/${encodeURIComponent(ref)}`;
const PINNED_HOST = 'api.pota.app';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const SPOTS_TTL_MS = 5 * 60_000;
const PARK_TTL_MS = 24 * 3600_000;
const PARK_MISS_TTL_MS = 5 * 60_000;
const MAX_PARK_LOOKUPS = 400;
const USER_AGENT = 'Gods Eye View (POTA spot context)';

let spotsCache = null; // {at, payload}
let spotsInflight = null;
const parkCache = new Map(); // ref -> {at, entry} ; entry null = dead ref
const parkInflight = new Map(); // ref -> Promise

function pinHost(responseUrl) {
  let host = '';
  try { host = new URL(responseUrl).hostname; } catch { /* opaque */ }
  if (host && host !== PINNED_HOST)
    throw Object.assign(new Error(`pota_redirect_off_host:${host}`), { status: 502 });
}

async function fetchJsonCapped(url, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`pota_upstream_${response.status}`), { status: 502 });
    pinHost(response.url);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('pota_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function numOrNull(value) {
  // Number(null)===0 is finite — without this, null coords/freqs read as 0.
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundNum(value, decimals) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function trimSpot(raw) {
  const freq = Number.parseFloat(raw?.frequency);
  return {
    spotId: numOrNull(raw?.spotId),
    spotTime: String(raw?.spotTime ?? ''),
    activator: String(raw?.activator ?? ''),
    frequencyKhz: Number.isFinite(freq) ? roundNum(freq, 1) : null,
    mode: String(raw?.mode ?? ''),
    reference: String(raw?.reference ?? ''),
    name: String(raw?.name ?? ''),
    locationDesc: String(raw?.locationDesc ?? ''),
    spotter: String(raw?.spotter ?? ''),
    source: String(raw?.source ?? ''),
  };
}

function trimPark(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = numOrNull(raw.latitude);
  const lon = numOrNull(raw.longitude);
  if (lat == null || lon == null) return null;
  return { lat: roundNum(lat, 4), lon: roundNum(lon, 4) };
}

async function getPark(ref) {
  const now = Date.now();
  const cached = parkCache.get(ref);
  if (cached) {
    const ttl = cached.entry ? PARK_TTL_MS : PARK_MISS_TTL_MS;
    if (now - cached.at < ttl) return cached.entry;
  }
  if (!parkInflight.has(ref)) {
    parkInflight.set(ref, (async () => {
      try {
        const upstream = await fetchJsonCapped(PARK_URL(ref), null);
        const entry = trimPark(upstream);
        parkCache.set(ref, { at: Date.now(), entry });
        return entry;
      } catch {
        // dead refs (e.g. retired prefixes) must not stampede the upstream
        parkCache.set(ref, { at: Date.now(), entry: null });
        return null;
      } finally {
        parkInflight.delete(ref);
      }
    })());
  }
  return parkInflight.get(ref);
}

export function trimPotaPayload(spots) {
  const rows = (Array.isArray(spots) ? spots : []).map(trimSpot).filter((s) => s.reference);
  return {
    generatedAt: new Date().toISOString(),
    count: rows.length,
    spots: rows,
    withCoords: 0,
    source: 'api.pota.app — Parks on the Air live spots (keyless)',
    honesty: 'Spots are live self/spotter reports; park coords are the registered ' +
      'park location (may lag new refs), cached up to 24 h.',
  };
}

async function getSnapshot(limit, mode) {
  const now = Date.now();
  if (spotsCache && now - spotsCache.at < SPOTS_TTL_MS) {
    return applyQuery(spotsCache.payload, limit, mode);
  }
  if (!spotsInflight) {
    spotsInflight = fetchJsonCapped(SPOTS_URL, null)
      .then(async (upstream) => {
        const payload = trimPotaPayload(upstream);
        const refs = [...new Set(payload.spots.map((s) => s.reference))].slice(0, MAX_PARK_LOOKUPS);
        await Promise.all(refs.map(getPark));
        for (const spot of payload.spots) {
          const entry = parkCache.get(spot.reference)?.entry;
          if (entry) {
            spot.lat = entry.lat;
            spot.lon = entry.lon;
            payload.withCoords += 1;
          } else {
            spot.lat = null;
            spot.lon = null;
          }
        }
        spotsCache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => { spotsInflight = null; });
  }
  return applyQuery(await spotsInflight, limit, mode);
}

function applyQuery(payload, limit, mode) {
  let spots = payload.spots;
  if (mode) {
    const want = mode.toUpperCase();
    spots = spots.filter((s) => s.mode.toUpperCase() === want);
  }
  const capped = Math.max(1, Math.min(limit || 200, 500));
  return {
    ...payload,
    count: spots.length,
    spots: spots.slice(0, capped),
  };
}

function sendJson(res, status, body, cacheControl = 'public, max-age=120') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

function parseQuery(url) {
  try {
    return new URL(url, 'http://x').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Mount the POTA proxy. Mirrors the nwsAlerts provider shape. */
export function potaProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const params = parseQuery(req.url);
      const limit = Number.parseInt(params.get('limit') ?? '', 10);
      const mode = params.get('mode');
      sendJson(res, 200, await getSnapshot(limit, mode));
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'pota_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'pota',
    configureServer({ middlewares }) {
      middlewares.use('/api/pota', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/pota', handler);
    },
  };
}

export const _potaInternals = {
  trimSpot,
  trimPark,
  trimPotaPayload,
  applyQuery,
  clearCaches: () => {
    spotsCache = null;
    spotsInflight = null;
    parkCache.clear();
    parkInflight.clear();
  },
};
