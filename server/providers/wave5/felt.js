/**
 * EMSC felt-earthquake proxy (keyless, crowd-sourced).
 *
 * EMSC's felt_quakes endpoint serves a rolling 72h GeoJSON of earthquakes
 * that drew "felt it" testimonies. Browsers cannot fetch it directly
 * (no CORS), so this provider trims the payload to what the globe needs
 * and caches it.
 *
 * Routes:
 *   GET /api/felt → {generatedAt, count, totalTestimonies, events:[...]}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const UPSTREAM_URL = 'https://www.emsc-csem.org/Tools/api/felt/felt_quakes.geojson.php';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60_000;
const COORD_DECIMALS = 4;
const USER_AGENT = 'Gods Eye View (public felt-earthquake context)';

let cache = null; // {at, payload}
let inflight = null;

async function fetchJsonCapped(url, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`emsc_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('emsc_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function roundNum(value) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** COORD_DECIMALS;
  return Math.round(value * factor) / factor;
}

function num(value) {
  return Number.isFinite(value) ? value : null;
}

export function trimFeltEvent(feature) {
  const props = feature?.properties ?? {};
  const coords = feature?.geometry?.type === 'Point'
    ? feature.geometry.coordinates
    : [];
  const timeMs = Date.parse(props.time ?? '');
  return {
    id: String(props.evid ?? ''),
    name: String(props.name ?? ''),
    mag: num(props.mag),
    depthKm: num(props.depth_km),
    lon: roundNum(num(coords[0]) ?? NaN) ?? null,
    lat: roundNum(num(coords[1]) ?? NaN) ?? null,
    timeMs: Number.isFinite(timeMs) ? timeMs : null,
    timeISO: String(props.time ?? ''),
    testimonyCount: Number.isFinite(props.testimonyCount) ? props.testimonyCount : 0,
    feltReportCount: Number.isFinite(props.feltReportCount) ? props.feltReportCount : 0,
    mediaCount: Number.isFinite(props.mediaCount) ? props.mediaCount : 0,
    url: String(props.url ?? ''),
  };
}

export function trimFeltPayload(upstream) {
  const features = Array.isArray(upstream?.features) ? upstream.features : [];
  const events = features
    .map(trimFeltEvent)
    .filter((e) => e.id && Number.isFinite(e.lon) && Number.isFinite(e.lat))
    .sort((a, b) => b.testimonyCount - a.testimonyCount);
  return {
    generatedAt: new Date().toISOString(),
    count: events.length,
    totalTestimonies: events.reduce((sum, e) => sum + e.testimonyCount, 0),
    events,
    window: 'rolling 72h',
    source: 'EMSC felt-earthquake feed (crowd-sourced testimonies, keyless)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = fetchJsonCapped(UPSTREAM_URL, null)
      .then((upstream) => {
        const payload = trimFeltPayload(upstream);
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the EMSC felt-earthquake proxy. Mirrors the nwsAlerts provider shape. */
export function feltProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    req.on?.('close', () => {});
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      sendJson(res, error?.status === 502 ? 502 : 500, {
        error: 'felt_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    } finally {
      req.removeListener?.('close', () => {});
    }
  }

  return {
    name: 'felt',
    configureServer({ middlewares }) {
      middlewares.use('/api/felt', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/felt', handler);
    },
  };
}

export const _feltInternals = {
  trimFeltEvent,
  trimFeltPayload,
  clearCaches: () => { cache = null; inflight = null; },
};
