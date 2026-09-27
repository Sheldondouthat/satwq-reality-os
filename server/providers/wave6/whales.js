/**
 * Wave 6 #33 — robots4whales acoustic whale detections proxy (keyless, WHOI attribution).
 *
 * Upstreams (robots4whales.whoi.edu, the site's own WordPress plugin API):
 *   detections : https://robots4whales.whoi.edu/wp-json/r4w/v1/species-detections
 *                fields per catalog: platform, datetime, lat, lon, analyst, species
 *                (blue / fin / humpback / sei / right whales; gliders + moored buoys)
 *   platforms  : https://robots4whales.whoi.edu/wp-json/r4w/v1/platforms
 *                (the detection platforms — join key for #140)
 *
 * Routes:
 *   GET /api/whales → {generatedAt, sources:{...}, count, detections:[...],
 *                      platforms:[...]}
 *
 * A 502 is returned only when EVERY source fails; partial results are
 * reported honestly per source.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error'
 * throws at the edge (main 2ec4053) — no node: imports, no WASM).
 *
 * HONESTY NOTE: robots4whales.whoi.edu timed out from the build VM on
 * 2026-09-27 (curl 000 on both endpoints; VM-throttled — needs a Worker-side
 * probe). The exact upstream JSON schema was NOT verified from this VM.
 * Field knowledge comes from the MASTER-FEED-CATALOG entry (#140/#141:
 * "JSON: platform/datetime/lat/lon/analyst/species", "JSON 16 buoys") plus
 * WordPress REST conventions. The parsers below are deliberately DEFENSIVE:
 * they accept a bare JSON array or any of the {data|detections|results}
 * wrappers, tolerate several key spellings per field, and normalize species
 * loosely. If the live schema differs materially, the provider returns an
 * honest 502 rather than garbage. This must be re-verified after the
 * Worker probe.
 */

const DETECTIONS_URL =
  'https://robots4whales.whoi.edu/wp-json/r4w/v1/species-detections';
const PLATFORMS_URL = 'https://robots4whales.whoi.edu/wp-json/r4w/v1/platforms';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60_000;
const MAX_DETECTIONS = 300;
const USER_AGENT = 'Gods Eye View (public whale-detection context)';

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

/** First spelling that yields a non-empty string wins. */
function pickStr(obj, spellings) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of spellings) {
    const v = obj[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
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

/** Accept a bare array or common wrapper objects. */
export function detectionArray(upstream) {
  if (Array.isArray(upstream)) return upstream;
  if (!upstream || typeof upstream !== 'object') return [];
  for (const k of ['data', 'detections', 'results', 'items']) {
    if (Array.isArray(upstream[k])) return upstream[k];
  }
  return [];
}

/** Known baleen-whale species from the program (gliders listen for these). */
const KNOWN_SPECIES = ['blue', 'fin', 'humpback', 'sei', 'right'];

export function normalizeSpecies(raw) {
  const s = String(raw ?? '')
    .toLowerCase()
    .trim();
  if (!s) return null;
  if (KNOWN_SPECIES.includes(s)) return s;
  if (s.includes('right whale')) return 'right';
  if (s.includes('humpback')) return 'humpback';
  if (s.includes('sei')) return 'sei';
  if (s.includes('blue whale')) return 'blue';
  if (s.startsWith('fin')) return 'fin';
  return 'other';
}

export function trimDetection(row) {
  const lat = pickNum(row, ['lat', 'Lat', 'LAT', 'latitude', 'Latitude']);
  const lon = pickNum(row, [
    'lon',
    'Lon',
    'LON',
    'lng',
    'Lng',
    'longitude',
    'Longitude',
  ]);
  if (!isFiniteNum(lat) || !isFiniteNum(lon)) return null;
  const speciesRaw = pickStr(row, [
    'species',
    'Species',
    'SPECIES',
    'commonName',
    'name',
  ]);
  const datetimeRaw = pickStr(row, [
    'datetime',
    'date',
    'Date',
    'time',
    'timestamp',
    'detectionDate',
    'created',
  ]);
  const timeMs = datetimeRaw ? Date.parse(datetimeRaw) : NaN;
  const species = normalizeSpecies(speciesRaw);
  if (!species) return null;
  return {
    platform: pickStr(row, [
      'platform',
      'Platform',
      'station',
      'buoy',
      'glider',
      'unit',
    ]),
    species,
    speciesRaw: speciesRaw ? speciesRaw.slice(0, 80) : null,
    lat: roundNum(lat),
    lon: roundNum(lon),
    datetime: Number.isFinite(timeMs)
      ? new Date(timeMs).toISOString()
      : datetimeRaw
        ? datetimeRaw.slice(0, 80)
        : null,
    analyst: pickStr(row, ['analyst', 'Analyst', 'analystName', 'reviewer']),
  };
}

export function trimPlatform(row) {
  const lat = pickNum(row, ['lat', 'Lat', 'LAT', 'latitude', 'Latitude']);
  const lon = pickNum(row, [
    'lon',
    'Lon',
    'LON',
    'lng',
    'Lng',
    'longitude',
    'Longitude',
  ]);
  if (!isFiniteNum(lat) || !isFiniteNum(lon)) return null;
  return {
    id: (
      pickStr(row, ['id', 'Id', 'ID', 'platform', 'name']) ?? `${lat},${lon}`
    ).slice(0, 120),
    name: pickStr(row, ['name', 'Name', 'title', 'platform']),
    type: pickStr(row, ['type', 'Type', 'platformType', 'kind']),
    lat: roundNum(lat),
    lon: roundNum(lon),
  };
}

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
      throw Object.assign(new Error(`whales_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('whales_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneSource({ key, url, trim }) {
  const started = Date.now();
  try {
    const upstream = await fetchJsonCapped(url);
    const items = detectionArray(upstream)
      .map(trim)
      .filter(Boolean)
      .slice(0, MAX_DETECTIONS);
    return {
      key,
      ok: true,
      count: items.length,
      latencyMs: Date.now() - started,
      items,
    };
  } catch (error) {
    return {
      key,
      ok: false,
      count: 0,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      items: [],
    };
  }
}

function buildSnapshot(results) {
  const sources = {};
  let detections = [];
  let platforms = [];
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      count: r.count,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
    if (r.key === 'detections' && r.ok) detections = r.items;
    if (r.key === 'platforms' && r.ok) platforms = r.items;
  }
  detections.sort((a, b) => {
    const ta = a.datetime ? Date.parse(a.datetime) : NaN;
    const tb = b.datetime ? Date.parse(b.datetime) : NaN;
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    if (Number.isFinite(tb)) return 1;
    if (Number.isFinite(ta)) return -1;
    return 0;
  });
  const speciesCounts = {};
  for (const d of detections)
    speciesCounts[d.species] = (speciesCounts[d.species] ?? 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: detections.length,
    platformCount: platforms.length,
    speciesCounts,
    detections,
    platforms,
    attribution:
      'robots4whales / Woods Hole Oceanographic Institution (near real-time acoustic detections, keyless)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    const sources = [
      { key: 'detections', url: DETECTIONS_URL, trim: trimDetection },
      { key: 'platforms', url: PLATFORMS_URL, trim: trimPlatform },
    ];
    inflight = Promise.all(sources.map(fetchOneSource))
      .then((results) => {
        if (!results.some((r) => r.ok)) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(
            new Error(`whales_all_upstream_down: ${detail}`),
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

function sendJson(res, status, body, cacheControl = 'public, max-age=1500') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the robots4whales proxy. Mirrors the wave-5 provider shape. */
export function whalesProxy() {
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
          error: 'whales_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'whales',
    configureServer({ middlewares }) {
      middlewares.use('/api/whales', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/whales', handler);
    },
  };
}

export const _whalesInternals = {
  detectionArray,
  normalizeSpecies,
  trimDetection,
  trimPlatform,
  buildSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
