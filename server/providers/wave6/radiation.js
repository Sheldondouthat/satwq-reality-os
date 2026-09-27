/**
 * Wave 6 #32 — gmcmap Geiger-counter network proxy (keyless, attribution).
 *
 * Upstreams:
 *   CPM map : https://gmcmap.com/ajaxm.php  (~100 live stations, counts/min)
 *   radon   : https://gmcmap.com/ajaxmr.php (pCi/L + Bq/m³)
 * Attribution: gmcmap.com (public volunteer network).
 *
 * Routes:
 *   GET /api/radiation → {generatedAt, sources:{...}, stations:[...],
 *                         radonStations:[...]}
 *
 * A 502 is returned only when EVERY source fails; partial results are
 * reported honestly per source.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error'
 * throws at the edge (main 2ec4053) — no node: imports, no WASM).
 *
 * HONESTY NOTE: gmcmap.com timed out from the build VM on 2026-09-27
 * (curl 000 on both endpoints; VM-throttled — needs a Worker-side probe).
 * The exact upstream JSON schema was NOT verified from this VM. The parsers
 * below are deliberately DEFENSIVE: they accept a bare JSON array or any of
 * the {stations|markers|data|results|points} wrappers, tolerate several key
 * spellings per field, and strip non-JSON wrappers around "JSON-ish" bodies.
 * If the live schema differs materially, the provider returns an honest 502
 * rather than garbage. This must be re-verified after the Worker probe.
 */

const CPM_URL = 'https://gmcmap.com/ajaxm.php';
const RADON_URL = 'https://gmcmap.com/ajaxmr.php';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_STATIONS = 1000;
const USER_AGENT = 'Gods Eye View (public radiation context)';

let cache = null; // {at, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function roundNum(value, decimals = 4) {
  if (!isFiniteNum(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function numOrNull(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** First spelling that yields a finite number wins. */
function pickNum(obj, spellings) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of spellings) {
    const v = numOrNull(obj[k]);
    if (v != null) return v;
  }
  return null;
}

/** First spelling that yields a non-empty string wins. */
function pickStr(obj, spellings) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of spellings) {
    const v = obj[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/** Accept a bare array or common wrapper objects. */
export function stationArray(upstream) {
  if (Array.isArray(upstream)) return upstream;
  if (!upstream || typeof upstream !== 'object') return [];
  for (const k of [
    'stations',
    'markers',
    'data',
    'results',
    'points',
    'counters',
  ]) {
    if (Array.isArray(upstream[k])) return upstream[k];
  }
  return [];
}

/**
 * Parse possibly-wrapped ("JSON-ish") text. Strips leading/trailing
 * non-JSON noise before JSON.parse. Returns the parsed value or throws
 * a 502-classed Error when the body is not parseable.
 */
export function parseLenientJson(text) {
  const raw = String(text ?? '');
  const stripped = raw.trim();
  try {
    return JSON.parse(stripped);
  } catch (first) {
    const start = stripped.search(/[{[]/);
    if (start >= 0) {
      try {
        return JSON.parse(stripped.slice(start));
      } catch {
        // fall through to the honest error below
      }
    }
    throw Object.assign(
      new Error(`radiation_unparseable_body: ${first?.message ?? 'unknown'}`),
      { status: 502 },
    );
  }
}

export function trimCpmStation(row) {
  const lat = pickNum(row, ['lat', 'Lat', 'LAT', 'latitude', 'Latitude']);
  const lon = pickNum(row, [
    'lng',
    'Lng',
    'LNG',
    'lon',
    'Lon',
    'LON',
    'long',
    'longitude',
    'Longitude',
  ]);
  if (!isFiniteNum(lat) || !isFiniteNum(lon)) return null;
  const cpm = pickNum(row, ['CPM', 'cpm', 'Cpm']);
  const id =
    pickStr(row, ['Id', 'id', 'ID', 'stationId', 'StationId', 'name']) ??
    `${lat},${lon}`;
  return {
    id: id.slice(0, 120),
    name: pickStr(row, ['Name', 'name', 'title']),
    lat: roundNum(lat),
    lon: roundNum(lon),
    cpm,
    usvPerHour: pickNum(row, ['uSv', 'uSvH', 'usvh', 'usv', 'uSv_h', 'dose']),
    alert:
      pickStr(row, ['alert', 'Alert', 'alarm']) != null
        ? /^(1|true|yes|alert|alarm)$/i.test(
            String(pickStr(row, ['alert', 'Alert', 'alarm'])),
          )
        : null,
    time: pickStr(row, ['time', 'Time', 'timestamp', 'date', 'lastUpdate']),
  };
}

export function trimRadonStation(row) {
  const lat = pickNum(row, ['lat', 'Lat', 'LAT', 'latitude', 'Latitude']);
  const lon = pickNum(row, [
    'lng',
    'Lng',
    'LNG',
    'lon',
    'Lon',
    'LON',
    'long',
    'longitude',
    'Longitude',
  ]);
  if (!isFiniteNum(lat) || !isFiniteNum(lon)) return null;
  const id =
    pickStr(row, ['Id', 'id', 'ID', 'stationId', 'StationId', 'name']) ??
    `${lat},${lon}`;
  return {
    id: id.slice(0, 120),
    name: pickStr(row, ['Name', 'name', 'title']),
    lat: roundNum(lat),
    lon: roundNum(lon),
    pCiPerL: pickNum(row, ['pCi', 'pCiL', 'pCi/L', 'pCi_l', 'radon']),
    bqPerM3: pickNum(row, ['bq', 'Bq', 'bqm3', 'Bq/m3', 'bq_m3']),
    time: pickStr(row, ['time', 'Time', 'timestamp', 'date', 'lastUpdate']),
  };
}

async function fetchTextCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain',
      },
    });
    if (!response.ok)
      throw Object.assign(new Error(`radiation_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('radiation_upstream_too_large'), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneSource({ key, url, trim }) {
  const started = Date.now();
  try {
    const text = await fetchTextCapped(url);
    const upstream = parseLenientJson(text);
    const stations = stationArray(upstream)
      .map(trim)
      .filter(Boolean)
      .slice(0, MAX_STATIONS);
    return {
      key,
      ok: true,
      count: stations.length,
      latencyMs: Date.now() - started,
      stations,
    };
  } catch (error) {
    return {
      key,
      ok: false,
      count: 0,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      stations: [],
    };
  }
}

function buildSnapshot(results) {
  const sources = {};
  let stations = [];
  let radonStations = [];
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      count: r.count,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
    if (r.key === 'cpm' && r.ok) stations = r.stations;
    if (r.key === 'radon' && r.ok) radonStations = r.stations;
  }
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: stations.length,
    radonCount: radonStations.length,
    stations,
    radonStations,
    attribution:
      'gmcmap.com Geiger-counter network (volunteer stations, keyless)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    const sources = [
      { key: 'cpm', url: CPM_URL, trim: trimCpmStation },
      { key: 'radon', url: RADON_URL, trim: trimRadonStation },
    ];
    inflight = Promise.all(sources.map(fetchOneSource))
      .then((results) => {
        if (!results.some((r) => r.ok)) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(
            new Error(`radiation_all_upstream_down: ${detail}`),
            { status: 502 },
          );
        }
        const payload = buildSnapshot(results);
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

/** Mount the gmcmap radiation proxy. Mirrors the wave-5 provider shape. */
export function radiationProxy() {
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
          error: 'radiation_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'radiation',
    configureServer({ middlewares }) {
      middlewares.use('/api/radiation', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/radiation', handler);
    },
  };
}

export const _radiationInternals = {
  stationArray,
  parseLenientJson,
  trimCpmStation,
  trimRadonStation,
  buildSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
