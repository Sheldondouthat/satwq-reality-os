/**
 * Wave 6 — SondeHub radiosonde proxy (keyless, community open).
 *
 * SondeHub's v2 API serves the global radiosonde (weather-balloon
 * tracker) fleet as JSON keyed by serial number: lat/lon/alt/type plus
 * uploader and last-seen time. This provider trims each sonde to the
 * fields the globe needs and caches for 5 minutes.
 *
 * Routes:
 *   GET /api/sondes → {generatedAt, count, airborne, sondes:[...]}
 *
 * Sonde shape: {serial, lat, lon, altM, type, subtype, uploader, lastSeen}
 * where `airborne` counts sondes with a reported altitude above 100 m
 * (sane separation from ground stations / decoders in the same feed).
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const UPSTREAM_URL = 'https://api.v2.sondehub.org/sondes';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const AIRBORNE_ALT_M = 100;
const USER_AGENT = 'Gods Eye View (radiosonde fleet context)';

let cache = null; // {at, payload}
let inflight = null;

async function fetchJsonCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`sondes_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('sondes_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error?.status === 502) throw error;
    if (error instanceof SyntaxError)
      throw Object.assign(new Error('sondes_upstream_bad_json'), {
        status: 502,
      });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function numOrNull(value, decimals = 4) {
  // NOTE: Number(null) === 0, so nulls must be screened before coercion.
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function validLatLon(lat, lon) {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

export function trimSonde(serial, raw) {
  const lat = numOrNull(raw?.lat);
  const lon = numOrNull(raw?.lon);
  if (!validLatLon(lat, lon)) return null;
  const timeMs = Date.parse(raw?.time ?? '');
  return {
    serial: String(serial ?? '').slice(0, 64),
    lat,
    lon,
    altM: numOrNull(raw?.alt, 1),
    type: String(raw?.type ?? '').slice(0, 32),
    subtype: String(raw?.subtype ?? '').slice(0, 32),
    uploader: String(raw?.uploader ?? raw?.uploader_callsign ?? '').slice(
      0,
      32,
    ),
    lastSeen: Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : null,
  };
}

/** SondeHub v2 response is a plain object keyed by serial number. */
export function trimSondesPayload(upstream) {
  const sondes = [];
  if (upstream && typeof upstream === 'object' && !Array.isArray(upstream)) {
    for (const [serial, raw] of Object.entries(upstream)) {
      const s = trimSonde(serial, raw);
      if (s) sondes.push(s);
    }
  }
  // Most recently seen first; unknown timestamps sink to the bottom.
  sondes.sort((a, b) =>
    String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')),
  );
  return {
    generatedAt: new Date().toISOString(),
    count: sondes.length,
    airborne: sondes.filter((s) => s.altM != null && s.altM > AIRBORNE_ALT_M)
      .length,
    band: '400-406 MHz (meteorological aids)',
    sondes,
    source: 'SondeHub v2 (community open data)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = fetchJsonCapped(UPSTREAM_URL)
      .then((upstream) => {
        const payload = trimSondesPayload(upstream);
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=300') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the SondeHub radiosonde proxy. Mirrors the felt provider shape. */
export function sondesProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'sondes_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'sondes',
    configureServer({ middlewares }) {
      middlewares.use('/api/sondes', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sondes', handler);
    },
  };
}

export const _sondesInternals = {
  trimSonde,
  trimSondesPayload,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
