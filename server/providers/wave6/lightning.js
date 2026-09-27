/**
 * Wave 6 — lightning proxy (GOES Geostationary Lightning Mapper context, keyless).
 *
 * Catalog #138–139:
 *   GLM strikes mirror — https://raw.githubusercontent.com/Meteoscience1/lightning-strikes-data/main/recent_strikes.json
 *     (JSON ~89 KB, ~1,872 strikes, 10-min cadence; NOAA GOES public-domain data via third-party mirror)
 *   RealEarth GLM tiles — https://realearth.ssec.wisc.edu/api/times?products=GOESEastGLMFEDRadC
 *     (JSON listing of available GLM Flash Extent Density tile times; UW-SSEC, attribution)
 *
 * Routes:
 *   GET /api/lightning → {generatedAt, sources:{...}, count, strikes:[...], tiles:{...}}
 *
 * Strikes are normalized to {lat, lon, time}; the parser tolerates the
 * mirror changing shape (bare array, {strikes:[...]}, or GeoJSON). The
 * RealEarth source contributes tile availability metadata (latest product
 * times + a tile URL template) rather than binary PNGs.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const GLM_MIRROR_URL = 'https://raw.githubusercontent.com/Meteoscience1/lightning-strikes-data/main/recent_strikes.json';
const REAL_EARTH_TIMES_URL = 'https://realearth.ssec.wisc.edu/api/times?products=GOESEastGLMFEDRadC';
const REAL_EARTH_TILE_TEMPLATE = 'https://realearth.ssec.wisc.edu/api/image?products=GOESEastGLMFEDRadC&time={time}&x={x}&y={y}&z={z}&format=png';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_STRIKES = 5000;
const USER_AGENT = 'Gods Eye View (public lightning-strike context)';

let cache = null; // {at, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function round4(v) {
  if (!isFiniteNum(v)) return v;
  return Math.round(v * 10000) / 10000;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampLatLon(lat, lon) {
  if (!isFiniteNum(lat) || !isFiniteNum(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat: round4(lat), lon: round4(lon) };
}

function timeToIso(v) {
  if (v == null) return null;
  const ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Tolerate several mirror shapes for a single strike record:
 * {lat,lon,time}, {latitude,longitude,timestamp}, GeoJSON-ish {coordinates,time}, etc.
 */
export function normalizeStrike(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = numOrNull(raw.lat ?? raw.latitude ?? raw.y ?? raw.coords?.[1] ?? raw.coordinates?.[1]);
  const lon = numOrNull(raw.lon ?? raw.lng ?? raw.long ?? raw.longitude ?? raw.x ?? raw.coords?.[0] ?? raw.coordinates?.[0]);
  const ll = clampLatLon(lat, lon);
  if (!ll) return null;
  return {
    lat: ll.lat,
    lon: ll.lon,
    time: timeToIso(raw.time ?? raw.timestamp ?? raw.t ?? raw.datetime ?? raw.observed),
  };
}

/** Extract the strike array from a bare array, {strikes:[...]}, {data:[...]}, or GeoJSON. */
export function parseGlmStrikes(upstream) {
  const out = [];
  const list = Array.isArray(upstream)
    ? upstream
    : Array.isArray(upstream?.strikes) ? upstream.strikes
    : Array.isArray(upstream?.data) ? upstream.data
    : upstream?.type === 'FeatureCollection' && Array.isArray(upstream?.features)
      ? upstream.features.map((f) => ({ ...(f?.properties ?? {}), lat: f?.geometry?.coordinates?.[1], lon: f?.geometry?.coordinates?.[0] }))
      : [];
  for (const raw of list) {
    const s = normalizeStrike(raw);
    if (s) out.push(s);
    if (out.length >= MAX_STRIKES) break;
  }
  // Newest first when times are known.
  out.sort((a, b) => Date.parse(b.time ?? 0) - Date.parse(a.time ?? 0));
  return out;
}

/** RealEarth /api/times returns per-product time lists; keep it metadata-only. */
export function parseRealEarthTimes(upstream) {
  const products = upstream?.products ?? upstream ?? {};
  const entry = products.GOESEastGLMFEDRadC ?? products.goeseastglmfedradc ?? null;
  const times = Array.isArray(entry?.times) ? entry.times
    : Array.isArray(entry) ? entry
    : Array.isArray(entry?.results) ? entry.results
    : [];
  const iso = times.map((t) => timeToIso(t)).filter(Boolean);
  iso.sort();
  return {
    product: 'GOESEastGLMFEDRadC',
    timeCount: iso.length,
    latest: iso.length ? iso[iso.length - 1] : null,
    tileUrlTemplate: REAL_EARTH_TILE_TEMPLATE,
  };
}

async function fetchJsonCapped(url, tag) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`lightning_${tag}_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error(`lightning_${tag}_upstream_too_large`), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error?.status === 502) throw error;
    if (error instanceof SyntaxError)
      throw Object.assign(new Error(`lightning_${tag}_upstream_bad_json`), { status: 502 });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneSource(key, url, parse) {
  const started = Date.now();
  try {
    const upstream = await fetchJsonCapped(url, key);
    return { key, ok: true, count: 0, latencyMs: Date.now() - started, data: parse(upstream) };
  } catch (error) {
    return { key, ok: false, count: 0, latencyMs: Date.now() - started, error: error?.message ?? 'unknown', data: null };
  }
}

function buildSnapshot(results) {
  const sources = {};
  let strikes = [];
  let tiles = null;
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
    if (!r.ok || !r.data) continue;
    if (r.key === 'glm_mirror') {
      strikes = r.data;
      sources[r.key].count = strikes.length;
      sources[r.key].attribution = 'NOAA GOES GLM public-domain data via Meteoscience1 mirror';
    } else if (r.key === 'realearth') {
      tiles = r.data;
      sources[r.key].attribution = 'UW-SSEC RealEarth (attribution)';
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: strikes.length,
    strikes,
    tiles,
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.all([
      fetchOneSource('glm_mirror', GLM_MIRROR_URL, parseGlmStrikes),
      fetchOneSource('realearth', REAL_EARTH_TIMES_URL, parseRealEarthTimes),
    ])
      .then((results) => {
        if (!results.some((r) => r.ok)) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(new Error(`lightning_all_upstream_down: ${detail}`), { status: 502 });
        }
        const payload = buildSnapshot(results);
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => { inflight = null; });
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

/** Mount the lightning proxy. Mirrors the wave-5 provider shape. */
export function lightningProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'lightning_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'lightning',
    configureServer({ middlewares }) {
      middlewares.use('/api/lightning', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/lightning', handler);
    },
  };
}

export const _lightningInternals = {
  normalizeStrike,
  parseGlmStrikes,
  parseRealEarthTimes,
  buildSnapshot,
  clearCaches: () => { cache = null; inflight = null; },
};
