/**
 * Wave 6 #31 — NDBC buoy observations proxy (keyless, NOAA public domain).
 *
 * Upstream: https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt
 * Format: whitespace-delimited text, hourly; 'MM' = missing value.
 * Column header (line 1): STN LAT LON YYYY MM DD hh mn WDIR WSPD GST WVHT DPD
 *   APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE
 *
 * Routes:
 *   GET /api/buoys[?limit=] → {generatedAt, count, buoys:[...]}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error'
 * throws at the edge (main 2ec4053) — no node: imports, no WASM).
 *
 * NOTE: https://ndbc.noaa.gov 301-redirects to https://www.ndbc.noaa.gov;
 * the pinned www.* URL is used AND redirect:'follow' is still set.
 * Shape VERIFIED by live probe from the build VM on 2026-09-27
 * (HTTP 200, ~103 KB, 868 rows incl. the two '#' header lines).
 */

const UPSTREAM_URL = 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60_000;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const USER_AGENT = 'Gods Eye View (public buoy observations)';

let cache = null; // {at, key, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** NDBC uses 'MM' for missing; empty strings and 'MM' both mean null. */
function numOrNull(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '' || s === 'MM') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function roundNum(value, decimals = 3) {
  if (!isFiniteNum(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

async function fetchTextCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`buoys_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('buoys_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

// Field indexes in the '#' column-header line:
//   0 STN, 1 LAT, 2 LON, 3 YYYY, 4 MM, 5 DD, 6 hh, 7 mn, 8 WDIR, 9 WSPD,
//   10 GST, 11 WVHT, 12 DPD, 13 APD, 14 MWD, 15 PRES, 16 PTDY, 17 ATMP,
//   18 WTMP, 19 DEWP, 20 VIS, 21 TIDE
export function parseBuoyRow(fields) {
  if (!Array.isArray(fields) || fields.length < 22) return null;
  const id = String(fields[0] ?? '').trim();
  const lat = numOrNull(fields[1]);
  const lon = numOrNull(fields[2]);
  if (!id || !isFiniteNum(lat) || !isFiniteNum(lon)) return null;
  const yr = Number(fields[3]);
  const mo = Number(fields[4]);
  const day = Number(fields[5]);
  const hr = Number(fields[6]);
  const mn = Number(fields[7]);
  const timeMs = Number.isFinite(yr) && Number.isFinite(mo) && Number.isFinite(day)
    ? Date.UTC(yr, mo - 1, day, Number.isFinite(hr) ? hr : 0, Number.isFinite(mn) ? mn : 0)
    : NaN;
  return {
    id,
    lat: roundNum(lat),
    lon: roundNum(lon),
    time: Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : null,
    windDirDeg: numOrNull(fields[8]),
    windSpeedMps: numOrNull(fields[9]),
    gustMps: numOrNull(fields[10]),
    waveHeightM: numOrNull(fields[11]),
    wavePeriodSec: numOrNull(fields[12]),
    waveDirDeg: numOrNull(fields[14]),
    presHpa: numOrNull(fields[15]),
    presTendencyHpa: numOrNull(fields[16]),
    airTempC: numOrNull(fields[17]),
    waterTempC: numOrNull(fields[18]),
    dewPointC: numOrNull(fields[19]),
    visNmi: numOrNull(fields[20]),
    tideFt: numOrNull(fields[21]),
  };
}

export function trimBuoyPayload(text, limit = DEFAULT_LIMIT) {
  const lines = String(text ?? '').split('\n');
  const buoys = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const b = parseBuoyRow(trimmed.split(/\s+/));
    if (b) buoys.push(b);
    if (buoys.length >= limit) break;
  }
  return {
    generatedAt: new Date().toISOString(),
    count: buoys.length,
    buoys,
    source: 'NDBC latest observations (NOAA public domain, keyless)',
  };
}

function clampLimit(raw) {
  // NOTE: Number(null) === 0, so nullish/empty must be screened before coercion.
  if (raw == null || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

async function getSnapshot(limit) {
  const now = Date.now();
  if (cache && cache.key === limit && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = fetchTextCapped(UPSTREAM_URL)
      .then((text) => {
        const payload = trimBuoyPayload(text, limit);
        cache = { at: Date.now(), key: limit, payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=1500') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the NDBC buoys proxy. Mirrors the wave-5 provider shape. */
export function buoysProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const url = new URL(req.url ?? '/api/buoys', 'http://localhost');
      sendJson(res, 200, await getSnapshot(clampLimit(url.searchParams.get('limit'))));
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'buoys_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'buoys',
    configureServer({ middlewares }) {
      middlewares.use('/api/buoys', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/buoys', handler);
    },
  };
}

export const _buoysInternals = {
  parseBuoyRow,
  trimBuoyPayload,
  numOrNull,
  clampLimit,
  clearCaches: () => { cache = null; inflight = null; },
};
