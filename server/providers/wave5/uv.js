/**
 * Open-Meteo UV/forecast proxy (keyless) — sun-safety ticker.
 *
 * Upstream: https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..
 *   &current=temperature_2m,uv_index,is_day
 *   &daily=sunrise,sunset,uv_index_max&timezone=auto
 * (verified live 2026-09-27; CC-BY 4.0 attribution required).
 *
 * Routes:
 *   GET /api/uv                           → default coords (40.7580, -73.9855, Times Square — neutral demo default)
 *   GET /api/uv?latitude=..&longitude=..  → arbitrary pinned point
 *
 * Latitude/longitude are validated, clamped, and rounded to 2 decimals for
 * cache-key hygiene (max 50 cached coordinate buckets, oldest evicted).
 *
 * Payload: {generatedAt, latitude, longitude, unit, value, current, today,
 * source, attribution}.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'error' pinned host, no node: imports, no WASM).
 */

import {
  fetchJsonCapped,
  makeCache,
  numOrNull,
  sendJson,
  buildProxy,
} from './_lib.js';

// Neutral demo default — never a personal location (ghost-first, 2026-09-30).
const DEFAULT_LAT = 40.758; // Times Square
const DEFAULT_LON = -73.9855;
const UPSTREAM_TIMEOUT_MS = 15_000;
const BODY_CAP_BYTES = 64 * 1024; // ~1 KB response; generous cap
const CACHE_TTL_MS = 30 * 60_000;
const MAX_CACHE_KEYS = 50;
const SOURCE = 'Open-Meteo forecast/UV';
const ATTRIBUTION = 'Open-Meteo (CC-BY 4.0) — https://open-meteo.com/';

/** Validate and normalize a lat/lon pair from query params. */
export function parseLatLon(query = {}) {
  let lat = numOrNull(query.latitude);
  let lon = numOrNull(query.longitude);
  if (lat === null) lat = DEFAULT_LAT;
  if (lon === null) lon = DEFAULT_LON;
  lat = Math.max(-90, Math.min(90, lat));
  lon = Math.max(-180, Math.min(180, lon));
  // 2-decimal rounding keeps the per-coordinate cache small (~11 km cells).
  return {
    latitude: Math.round(lat * 100) / 100,
    longitude: Math.round(lon * 100) / 100,
  };
}

export function openMeteoUrl({ latitude, longitude }) {
  return (
    'https://api.open-meteo.com/v1/forecast?' +
    `latitude=${latitude}&longitude=${longitude}` +
    '&current=temperature_2m,uv_index,is_day' +
    '&daily=sunrise,sunset,uv_index_max&timezone=auto'
  );
}

export function trimUvPayload(upstream, { latitude, longitude }) {
  if (!upstream || typeof upstream !== 'object')
    throw Object.assign(new Error('uv_upstream_shape'), { status: 502 });
  const current = upstream.current ?? {};
  const daily = upstream.daily ?? {};
  const idx = Array.isArray(daily.time) && daily.time.length ? 0 : -1;
  const uvIndex = numOrNull(current.uv_index);
  return {
    generatedAt: new Date().toISOString(),
    value: uvIndex,
    uvIndex,
    unit: 'UV index',
    latitude,
    longitude,
    current: {
      time: typeof current.time === 'string' ? current.time : null,
      uvIndex,
      isDay: current.is_day === 1,
      temperatureC: numOrNull(current.temperature_2m),
    },
    today: {
      date: idx >= 0 ? String(daily.time[idx]) : null,
      uvIndexMax: idx >= 0 ? numOrNull(daily.uv_index_max?.[idx]) : null,
      sunrise:
        idx >= 0 && typeof daily.sunrise?.[idx] === 'string'
          ? daily.sunrise[idx]
          : null,
      sunset:
        idx >= 0 && typeof daily.sunset?.[idx] === 'string'
          ? daily.sunset[idx]
          : null,
    },
    source: SOURCE,
    attribution: ATTRIBUTION,
  };
}

const buckets = new Map(); // "lat,lon" -> cache
function cacheFor(latLon) {
  const key = `${latLon.latitude},${latLon.longitude}`;
  let entry = buckets.get(key);
  if (!entry) {
    entry = makeCache(
      async () =>
        trimUvPayload(
          await fetchJsonCapped({
            url: openMeteoUrl(latLon),
            timeoutMs: UPSTREAM_TIMEOUT_MS,
            bodyCapBytes: BODY_CAP_BYTES,
            label: 'uv',
          }),
          latLon,
        ),
      CACHE_TTL_MS,
    );
    buckets.set(key, entry);
    if (buckets.size > MAX_CACHE_KEYS) {
      // Evict the oldest-inserted bucket (Map preserves insertion order).
      const oldest = buckets.keys().next().value;
      buckets.delete(oldest);
    }
  }
  return entry;
}

function parseQuery(req) {
  const full = String(req.originalUrl || req.url || '');
  const qIndex = full.indexOf('?');
  if (qIndex < 0) return {};
  const params = new URLSearchParams(full.slice(qIndex + 1));
  return {
    latitude: params.get('latitude'),
    longitude: params.get('longitude'),
  };
}

/** Mount the UV proxy. Mirrors the vaac/nwsAlerts provider shape. */
export function uvProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const latLon = parseLatLon(parseQuery(req));
      sendJson(res, 200, await cacheFor(latLon).get(), 'public, max-age=1800');
    } catch (error) {
      sendJson(
        res,
        error?.status === 502 ? 502 : 500,
        { error: 'uv_unavailable', detail: error?.message ?? 'unknown' },
        'no-store',
      );
    }
  }
  return buildProxy({ name: 'uv', route: '/api/uv', handler });
}

export const _uvInternals = {
  parseLatLon,
  openMeteoUrl,
  trimUvPayload,
  clearCaches: () => buckets.clear(),
};
