/**
 * Wave 6 #31 — NOAA CO-OPS tides proxy (keyless, NOAA public domain).
 *
 * Upstreams (all under https://api.tidesandcurrents.noaa.gov/api/prod/):
 *   water level : datagetter?product=water_level&station={id}&datum=MLLW&date=recent&time_zone=gmt&units=english&format=json
 *                 → {metadata:{id,name,lat,lon}, data:[{t,v,s,f,q}]}
 *   predictions : datagetter?product=predictions&station={id}&datum=MLLW&date=today&time_zone=gmt&units=english&interval=hilo&format=json
 *                 → {predictions:[{t,v,type}]}   type is 'H' or 'L'
 *
 * `datum=` is REQUIRED (the API 400s without it). units=english → feet.
 * Water level cadence is 6 minutes; `date=recent` returns up to 72h.
 *
 * Routes:
 *   GET /api/tides?station=8638610&kind=water_level|predictions|both
 *     → {generatedAt, station, sources:{...}, waterLevel:[...]|null,
 *        predictions:[...]|null}
 *
 * A 502 is returned only when EVERY requested product fails; partial
 * results are reported honestly per source.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error'
 * throws at the edge (main 2ec4053) — no node: imports, no WASM).
 *
 * Shapes VERIFIED by live probe from the build VM on 2026-09-27
 * (both endpoints HTTP 200 JSON; no redirect observed on
 * api.tidesandcurrents.noaa.gov).
 */

const COOPS_BASE = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const WATER_LEVEL_TTL_MS = 10 * 60_000;
const PREDICTIONS_TTL_MS = 6 * 60 * 60_000;
const MAX_READINGS = 500;
const USER_AGENT = 'Gods Eye View (public tide context)';
const STATION_RE = /^\d{1,7}$/;
// Default station: 8638610 Sewells Point VA (near the user's region).

let cache = null; // {at, key, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function roundNum(value, decimals = 3) {
  if (!isFiniteNum(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function numOrNull(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** CO-OPS times arrive as '2026-09-27 01:41' with time_zone=gmt → parse as UTC. */
function coopsTimeToISO(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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
      throw Object.assign(new Error(`tides_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('tides_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

export function parseWaterLevel(upstream) {
  const rows = Array.isArray(upstream?.data) ? upstream.data : [];
  const readings = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const t = coopsTimeToISO(r.t);
    const v = numOrNull(r.v);
    if (!t || !isFiniteNum(v)) continue;
    readings.push({ time: t, feet: roundNum(v), quality: String(r.q ?? '') || null });
  }
  return readings.slice(0, MAX_READINGS);
}

export function parsePredictions(upstream) {
  const rows = Array.isArray(upstream?.predictions) ? upstream.predictions : [];
  const preds = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const t = coopsTimeToISO(r.t);
    const v = numOrNull(r.v);
    if (!t || !isFiniteNum(v)) continue;
    const type = String(r.type ?? '').toUpperCase();
    preds.push({ time: t, feet: roundNum(v), type: type === 'H' || type === 'L' ? type : null });
  }
  return preds;
}

function waterLevelUrl(station) {
  return `${COOPS_BASE}?product=water_level&station=${station}&datum=MLLW&date=recent&time_zone=gmt&units=english&format=json`;
}

function predictionsUrl(station) {
  return `${COOPS_BASE}?product=predictions&station=${station}&datum=MLLW&date=today&time_zone=gmt&units=english&interval=hilo&format=json`;
}

async function fetchProduct(product, station) {
  const started = Date.now();
  const url = product === 'water_level' ? waterLevelUrl(station) : predictionsUrl(station);
  try {
    const upstream = await fetchJsonCapped(url);
    return {
      key: product,
      ok: true,
      latencyMs: Date.now() - started,
      metadata: upstream?.metadata ?? null,
      readings: product === 'water_level' ? parseWaterLevel(upstream) : parsePredictions(upstream),
    };
  } catch (error) {
    return {
      key: product,
      ok: false,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      readings: [],
    };
  }
}

function buildSnapshot(results, station) {
  const sources = {};
  let waterLevel = null;
  let predictions = null;
  let meta = null;
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      count: r.readings.length,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
    if (r.ok && !meta && r.metadata) meta = r.metadata;
    if (r.key === 'water_level' && r.ok) waterLevel = r.readings;
    if (r.key === 'predictions' && r.ok) predictions = r.readings;
  }
  const latest = waterLevel && waterLevel.length ? waterLevel[waterLevel.length - 1] : null;
  return {
    generatedAt: new Date().toISOString(),
    station: {
      id: String(station),
      name: meta?.name ? String(meta.name) : null,
      lat: numOrNull(meta?.lat),
      lon: numOrNull(meta?.lon),
    },
    sources,
    current: latest ? { ...latest, asOf: latest.time } : null,
    waterLevel,
    predictions,
    units: 'feet MLLW',
    attribution: 'NOAA CO-OPS (public domain, keyless)',
  };
}

export function parseQuery(req) {
  const url = new URL(req.url ?? '/api/tides', 'http://localhost');
  const station = url.searchParams.get('station') ?? '8638610';
  const kindRaw = (url.searchParams.get('kind') ?? 'water_level').toLowerCase();
  if (!STATION_RE.test(station))
    throw Object.assign(new Error(`tides_bad_station:${station.slice(0, 32)}`), { status: 400 });
  const kind = kindRaw === 'predictions' || kindRaw === 'both' ? kindRaw : 'water_level';
  return { station, kind };
}

async function getSnapshot(station, kind) {
  const key = `${station}:${kind}`;
  const ttl = kind === 'predictions' ? PREDICTIONS_TTL_MS : WATER_LEVEL_TTL_MS;
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < ttl) return cache.payload;
  if (!inflight) {
    const products = kind === 'water_level' ? ['water_level'] : kind === 'predictions' ? ['predictions'] : ['water_level', 'predictions'];
    inflight = Promise.all(products.map((p) => fetchProduct(p, station)))
      .then((results) => {
        if (!results.some((r) => r.ok)) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(new Error(`tides_all_upstream_down: ${detail}`), { status: 502 });
        }
        const payload = buildSnapshot(results, station);
        cache = { at: Date.now(), key, payload };
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

/** Mount the CO-OPS tides proxy. Mirrors the wave-5 provider shape. */
export function tidesProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const { station, kind } = parseQuery(req);
      sendJson(res, 200, await getSnapshot(station, kind));
    } catch (error) {
      if (error?.status === 400)
        return sendJson(res, 400, { error: 'tides_bad_station', detail: error?.message ?? 'unknown' }, 'no-store');
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'tides_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'tides',
    configureServer({ middlewares }) {
      middlewares.use('/api/tides', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/tides', handler);
    },
  };
}

export const _tidesInternals = {
  parseWaterLevel,
  parsePredictions,
  coopsTimeToISO,
  buildSnapshot,
  parseQuery,
  clearCaches: () => { cache = null; inflight = null; },
};
