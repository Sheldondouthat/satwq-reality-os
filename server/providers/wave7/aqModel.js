/**
 * Wave 7 — Open-Meteo air-quality MODEL layer.
 *
 * #137 Open-Meteo AQ
 * https://air-quality-api.open-meteo.com/v1/air-quality?latitude=..&longitude=..&current=pm2_5,ozone,us_aqi
 * #60 wave C
 *
 * CRITICAL HONESTY LABEL: this endpoint serves CAMS (Copernicus Atmosphere
 * Monitoring Service) MODEL output — a chemistry-transport simulation —
 * NOT physical sensor observations. The payload therefore carries
 * `"model": true` and a plain-language warning, so no client can mistake a
 * modeled grid cell for a measured reading. The observation side of the air
 * layer stays with Sensor.Community (/api/air-quality).
 *
 * Routes:
 *   GET /api/aq-model?lat=<deg>&lon=<deg> → model snapshot for the nearest CAMS grid cell
 *
 * Upstream (VERIFIED live 2026-09-27 from the build VM — 200, JSON envelope
 * exactly as parsed below; no redirect hops were observed on that probe,
 * but no "verified non-redirecting" claim is asserted as standing policy):
 *   {"latitude":37.300003,"longitude":-80.7,"generationtime_ms":0.247,...,
 *    "current_units":{"time":"iso8601","pm2_5":"μg/m³","ozone":"μg/m³","us_aqi":"USAQI"},
 *    "current":{"time":"2026-09-27T21:00","interval":3600,"pm2_5":2.4,"ozone":97.0,"us_aqi":40}}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 */

const UPSTREAM_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 256 * 1024;
const CACHE_TTL_MS = 10 * 60_000; // CAMS runs hourly; 10 min cache is aggressive but honest
const USER_AGENT = 'Gods Eye View (Open-Meteo CAMS model aggregation)';

let cache = new Map(); // key → {at, payload}
let inflight = new Map();

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundNum(value, decimals = 2) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 10 ** decimals) / 10 ** decimals
    : value;
}

/** Validate lat/lon query. Throws {status}. Pure, exported for tests. */
export function parseLocation(query) {
  // NOTE: Number(null) === 0, so missing/empty params must be screened
  // before coercion — otherwise ?lat=37 alone silently becomes (37, 0).
  const rawLat = query.get('lat');
  const rawLon = query.get('lon');
  const lat = rawLat == null || rawLat === '' ? NaN : Number(rawLat);
  const lon = rawLon == null || rawLon === '' ? NaN : Number(rawLon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw Object.assign(new Error('aq_bad_lat'), { status: 400 });
  }
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw Object.assign(new Error('aq_bad_lon'), { status: 400 });
  }
  return {
    lat: Math.round(lat * 1000) / 1000,
    lon: Math.round(lon * 1000) / 1000,
  };
}

/**
 * Normalize one Open-Meteo air-quality JSON envelope into the model-labeled
 * payload. Pure, exported for tests. `model: true` is the load-bearing
 * honesty field — do not drop it.
 */
export function parseModelPayload(upstream, requested) {
  const units = upstream?.current_units ?? {};
  const current = upstream?.current ?? {};
  const value = (name) => {
    const v = finiteOrNull(current[name]);
    return v == null ? null : roundNum(v);
  };
  return {
    generatedAt: new Date().toISOString(),
    model: true,
    modelName: 'CAMS (Copernicus Atmosphere Monitoring Service) via Open-Meteo',
    warning:
      'MODEL output — a chemistry-transport simulation, not physical sensor observations. Use /api/air-quality for citizen-sensor observations.',
    attribution:
      'Weather data by Open-Meteo.com (CC-BY 4.0); CAMS operated by ECMWF on behalf of the EU.',
    location: {
      requested,
      gridLat: finiteOrNull(upstream?.latitude),
      gridLon: finiteOrNull(upstream?.longitude),
      elevationM: finiteOrNull(upstream?.elevation),
      timezone:
        typeof upstream?.timezone === 'string' ? upstream.timezone : null,
    },
    current: {
      time: typeof current.time === 'string' ? current.time : null,
      intervalS: finiteOrNull(current.interval),
      pm2_5: value('pm2_5'),
      ozone: value('ozone'),
      usAqi: Number.isFinite(Number(current.us_aqi))
        ? Math.round(Number(current.us_aqi))
        : null,
      units: {
        pm2_5: typeof units.pm2_5 === 'string' ? units.pm2_5 : 'µg/m³',
        ozone: typeof units.ozone === 'string' ? units.ozone : 'µg/m³',
        usAqi: typeof units.us_aqi === 'string' ? units.us_aqi : 'USAQI',
      },
    },
    generationMs: finiteOrNull(upstream?.generationtime_ms),
  };
}

function buildUpstreamUrl({ lat, lon }) {
  const params = new URLSearchParams();
  params.set('latitude', String(lat));
  params.set('longitude', String(lon));
  params.set('current', 'pm2_5,ozone,us_aqi');
  params.set('timezone', 'auto');
  return `${UPSTREAM_BASE}?${params.toString()}`;
}

async function fetchJsonCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`aq_model_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('aq_model_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error?.status === 502) throw error;
    if (error instanceof SyntaxError)
      throw Object.assign(new Error('aq_model_upstream_bad_json'), {
        status: 502,
      });
    throw Object.assign(
      new Error(`aq_model_fetch_failed: ${error?.message ?? 'unknown'}`),
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function getSnapshot(location) {
  const key = `${location.lat.toFixed(3)},${location.lon.toFixed(3)}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.payload;
  let op = inflight.get(key);
  if (!op) {
    op = fetchJsonCapped(buildUpstreamUrl(location))
      .then((upstream) => {
        const payload = parseModelPayload(upstream, location);
        if (cache.size >= 64) cache.delete(cache.keys().next().value);
        cache.set(key, { at: Date.now(), payload });
        return payload;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, op);
  }
  return op;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-7 Open-Meteo AQ model proxy. Mirrors the trains provider shape. */
export function aqModelProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    let location;
    try {
      location = parseLocation(
        new URL(req.url, 'http://localhost').searchParams,
      );
    } catch (error) {
      return sendJson(
        res,
        error.status ?? 400,
        { error: error.message },
        'no-store',
      );
    }
    try {
      sendJson(res, 200, await getSnapshot(location));
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'aq_model_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'aq-model',
    configureServer({ middlewares }) {
      middlewares.use('/api/aq-model', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/aq-model', handler);
    },
  };
}

export const _aqModelInternals = {
  parseLocation,
  parseModelPayload,
  buildUpstreamUrl,
  clearCaches: () => {
    cache = new Map();
    inflight = new Map();
  },
};
