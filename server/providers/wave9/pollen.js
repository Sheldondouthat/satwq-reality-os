/**
 * Wave 9 (R2-8) — Pollen forecasts provider (Open-Meteo / CAMS pollen model).
 *
 * Backlog R2-8 ("pollen"): the round-2 audit noted "CAMS has it; Open-Meteo
 * does not" — that note is STALE as of 2026-09-30. Open-Meteo's keyless
 * air-quality API now serves six CAMS pollen fields (verified live from the
 * build VM 2026-09-30: Berlin returned 72/72 non-null hours per type,
 * units grains/m³). CAMS is the Copernicus Atmosphere Monitoring Service
 * chemistry-transport simulation — pollen is MODEL output, honestly labeled
 * (same mandatory label class as /api/aq-model: "Open-Meteo AQ = CAMS model").
 *
 * Coverage (OBSERVED 2026-09-30): CAMS pollen covers the European domain.
 * Berlin → real values (grass ≤0.1, ragweed ≤0.5 grains/m³, late-Sept low
 * season, plausible); Pembroke VA → all 6 types null across all 72 hours
 * (not zero, not missing keys — nulls). So: pinned LOCATIONS are 8 European
 * cities; a custom ?lat=&lon= point outside the domain yields an honest
 * all-null row with coverage:'outside-cams-pollen-domain', never fabricated.
 *
 * Upstream (verified live 2026-09-30):
 *   https://air-quality-api.open-meteo.com/v1/air-quality
 *     ?latitude=52.52&longitude=13.41
 *     &hourly=alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen
 *     &timezone=auto&forecast_days=3
 *   → 200, 72 hourly rows, hourly_units grains/m³ for all six types.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 *
 * Routes:
 *   GET /api/pollen              → all 8 pinned cities (8 subrequests)
 *   GET /api/pollen?city=berlin  → one pinned city (1 subrequest)
 *   GET /api/pollen?lat=..&lon=..→ custom point (1 subrequest)
 *   ?city=<unknown-but-wellformed> → 200 {requestedNotFound:true} (nexrad/goes pattern)
 *   bad city/lat/lon → 400
 *
 * Payload per location: {id,name,country,lat,lon,coverage,gridLat,gridLon,
 * timezone,dataHours,current:{6 types grains/m³},dailyMax:[{date,6 types}]}.
 * Raw 72×6 series are summarized (current + per-day maxima) to keep the
 * edge payload lean. 6h TTL + 7d key-scoped stale fallback; per-location
 * fail-soft (all locations unreachable → honest 502).
 */

const UPSTREAM_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 256 * 1024; // observed ~526 B for 72h; generous headroom
const CACHE_TTL_MS = 6 * 3600_000; // CAMS pollen runs ~2x daily; 6h is honest
const STALE_MS = 7 * 24 * 3600_000;
const RETRY_COOLDOWN_MS = 60_000;
const USER_AGENT = 'satwq-reality-os/1.0 (gods-eye-view; pollen layer; keyless)';

export const POLLEN_TYPES = ['alder', 'birch', 'grass', 'mugwort', 'olive', 'ragweed'];

/** Pinned locations — European cities inside the CAMS pollen domain. */
export const LOCATIONS = [
  { id: 'berlin', name: 'Berlin', country: 'Germany', lat: 52.52, lon: 13.41 },
  { id: 'paris', name: 'Paris', country: 'France', lat: 48.85, lon: 2.35 },
  { id: 'london', name: 'London', country: 'United Kingdom', lat: 51.51, lon: -0.13 },
  { id: 'madrid', name: 'Madrid', country: 'Spain', lat: 40.42, lon: -3.7 },
  { id: 'rome', name: 'Rome', country: 'Italy', lat: 41.9, lon: 12.5 },
  { id: 'warsaw', name: 'Warsaw', country: 'Poland', lat: 52.23, lon: 21.01 },
  { id: 'vienna', name: 'Vienna', country: 'Austria', lat: 48.21, lon: 16.37 },
  { id: 'amsterdam', name: 'Amsterdam', country: 'Netherlands', lat: 52.37, lon: 4.9 },
];

/** Number(null)===0 guard: null/NaN/empty upstream numerics become null, never 0. */
export function numOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null; // Number('')===0 trap
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function roundOrNull(v, decimals = 2) {
  const n = numOrNull(v);
  if (n == null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

const CITY_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Validate the query. Returns {mode:'all'|'city'|'point', city?, lat?, lon?}.
 * Throws {status:400} on malformed input; unknown-but-wellformed city ids
 * return {mode:'notfound'} (200 + requestedNotFound, per nexrad/goes).
 * Pure, exported for tests.
 */
export function parseQuery(query) {
  const cityRaw = query.get('city');
  const latRaw = query.get('lat');
  const lonRaw = query.get('lon');
  if (cityRaw != null && cityRaw !== '') {
    if (!CITY_ID_RE.test(cityRaw)) throw Object.assign(new Error('pollen_bad_city'), { status: 400 });
    const found = LOCATIONS.find((l) => l.id === cityRaw);
    if (!found) return { mode: 'notfound', city: cityRaw };
    return { mode: 'city', city: found };
  }
  if (latRaw != null || lonRaw != null) {
    // NOTE: Number(null)===0 — missing/empty params must be screened first.
    const lat = latRaw == null || latRaw === '' ? NaN : Number(latRaw);
    const lon = lonRaw == null || lonRaw === '' ? NaN : Number(lonRaw);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) throw Object.assign(new Error('pollen_bad_lat'), { status: 400 });
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) throw Object.assign(new Error('pollen_bad_lon'), { status: 400 });
    return { mode: 'point', lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
  }
  return { mode: 'all' };
}

export function buildUpstreamUrl({ lat, lon }) {
  const params = new URLSearchParams();
  params.set('latitude', String(lat));
  params.set('longitude', String(lon));
  params.set('hourly', POLLEN_TYPES.map((t) => `${t}_pollen`).join(','));
  params.set('timezone', 'auto');
  params.set('forecast_days', '3');
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
      throw Object.assign(new Error(`pollen_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('pollen_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error?.status === 502) throw error;
    if (error instanceof SyntaxError)
      throw Object.assign(new Error('pollen_upstream_bad_json'), { status: 502 });
    throw Object.assign(new Error(`pollen_fetch_failed: ${error?.message ?? 'unknown'}`), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Summarize one Open-Meteo pollen envelope for a location. Pure, exported
 * for tests. Returns the location row (summaries only — no raw series).
 * Throws {status:502} on bad shape (never returns fabricated pollen).
 */
export function parseLocationPayload(upstream, place) {
  const fail = (msg) => Object.assign(new Error(`pollen_invalid_payload: ${msg}`), { status: 502 });
  const hourly = upstream?.hourly;
  if (!hourly || !Array.isArray(hourly.time)) throw fail('missing hourly.time');
  const n = hourly.time.length;
  if (n === 0) throw fail('empty hourly.time');
  const series = {};
  for (const t of POLLEN_TYPES) {
    const arr = hourly[`${t}_pollen`];
    if (!Array.isArray(arr) || arr.length !== n) throw fail(`bad series ${t}_pollen`);
    series[t] = arr.map((v) => numOrNull(v));
  }
  // current = first hour with any non-null reading (timestamps are local, timezone=auto)
  let current = null;
  let currentTime = null;
  for (let i = 0; i < n; i++) {
    if (POLLEN_TYPES.some((t) => series[t][i] != null)) {
      current = {};
      for (const t of POLLEN_TYPES) current[t] = roundOrNull(series[t][i]);
      currentTime = typeof hourly.time[i] === 'string' ? hourly.time[i] : null;
      break;
    }
  }
  // daily maxima grouped by local calendar date
  const days = new Map();
  for (let i = 0; i < n; i++) {
    const ts = hourly.time[i];
    if (typeof ts !== 'string' || ts.length < 10) continue;
    const date = ts.slice(0, 10);
    if (!days.has(date)) days.set(date, {});
    const d = days.get(date);
    for (const t of POLLEN_TYPES) {
      const v = series[t][i];
      if (v != null && (d[t] == null || v > d[t])) d[t] = roundOrNull(v);
    }
  }
  const dailyMax = [...days.entries()].map(([date, vals]) => {
    const row = { date };
    for (const t of POLLEN_TYPES) row[t] = vals[t] ?? null;
    return row;
  });
  const nonNullTotal = POLLEN_TYPES.reduce(
    (acc, t) => acc + series[t].filter((v) => v != null).length, 0);
  const coverage = nonNullTotal > 0 ? 'cams-europe' : 'outside-cams-pollen-domain';
  const tz = upstream?.timezone;
  return {
    id: place.id,
    name: place.name,
    country: place.country,
    lat: place.lat,
    lon: place.lon,
    ok: true,
    coverage,
    gridLat: numOrNull(upstream?.latitude),
    gridLon: numOrNull(upstream?.longitude),
    timezone: typeof tz === 'string' ? tz : null,
    dataHours: n,
    nonNullValues: nonNullTotal,
    current,
    currentTime,
    dailyMax,
  };
}

/** Build the full payload envelope. Pure apart from generatedAt. */
export function buildPayload(rows, stale) {
  return {
    generatedAt: new Date().toISOString(),
    stale: Boolean(stale),
    model: true,
    modelName: 'CAMS (Copernicus Atmosphere Monitoring Service) pollen via Open-Meteo',
    warning:
      'MODEL output — a chemistry-transport simulation, not sensor observations. ' +
      'CAMS pollen covers the European domain; outside it all types read null (no data, never zero).',
    attribution: 'Pollen data by Open-Meteo.com (CC-BY 4.0); CAMS operated by ECMWF on behalf of the EU.',
    types: POLLEN_TYPES,
    units: 'grains/m³',
    locations: rows,
    honesty: {
      values: 'grains/m³ per CAMS model grid cell; null = no model value, never zero-filled (Number(\'\')===0 trap guarded).',
      coverage: 'cams-europe = inside the CAMS pollen domain; outside-cams-pollen-domain = upstream returned only nulls (e.g. North America).',
      current: 'first hourly row containing any non-null reading (local time via timezone=auto).',
      dailyMax: 'per-type maxima over local calendar days.',
    },
  };
}

// --- caches (per query key, mirroring wave9 conventions) ---
const payloadCache = new Map(); // key -> {at, payload}
const inflight = new Map();
let docFailedAt = -Infinity;
const PAYLOAD_CACHE_MAX = 16;

function queryKey(sel) {
  if (sel.mode === 'city') return `city:${sel.city.id}`;
  if (sel.mode === 'point') return `pt:${sel.lat.toFixed(3)},${sel.lon.toFixed(3)}`;
  return 'all';
}

export function selectionPlaces(sel) {
  if (sel.mode === 'city') return [sel.city];
  if (sel.mode === 'point')
    return [{ id: `pt-${sel.lat}-${sel.lon}`, name: 'Custom point', country: null, lat: sel.lat, lon: sel.lon }];
  return LOCATIONS;
}

async function fetchOne(place) {
  try {
    const upstream = await fetchJsonCapped(buildUpstreamUrl(place));
    return parseLocationPayload(upstream, place);
  } catch (error) {
    return {
      id: place.id, name: place.name, country: place.country, lat: place.lat, lon: place.lon,
      ok: false, error: error?.message ?? 'unknown', status: error?.status ?? 502,
    };
  }
}

async function getPayload(sel) {
  const key = queryKey(sel);
  const now = Date.now();
  const hit = payloadCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return { payload: hit.payload, stale: false };
  let op = inflight.get(key);
  if (!op) {
    if (now - docFailedAt < RETRY_COOLDOWN_MS && hit && now - hit.at < STALE_MS) {
      return { payload: hit.payload, stale: true };
    }
    op = (async () => {
      const places = selectionPlaces(sel);
      const rows = await Promise.all(places.map((p) => fetchOne(p)));
      const okRows = rows.filter((r) => r.ok);
      if (okRows.length === 0) {
        docFailedAt = Date.now();
        if (hit && now - hit.at < STALE_MS) return { payload: hit.payload, stale: true };
        throw Object.assign(new Error('pollen_all_upstreams_failed'), { status: 502 });
      }
      const payload = buildPayload(rows, false);
      if (payloadCache.size >= PAYLOAD_CACHE_MAX) payloadCache.delete(payloadCache.keys().next().value);
      payloadCache.set(key, { at: Date.now(), payload });
      return { payload, stale: false };
    })().finally(() => inflight.delete(key));
    inflight.set(key, op);
  }
  return op;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=21600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-9 pollen proxy. */
export function pollenProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    let sel;
    try {
      sel = parseQuery(new URL(req.url, 'http://localhost').searchParams);
    } catch (error) {
      return sendJson(res, error.status ?? 400, { error: error.message }, 'no-store');
    }
    if (sel.mode === 'notfound') {
      return sendJson(res, 200, { generatedAt: new Date().toISOString(), requestedNotFound: true, city: sel.city }, 'no-store');
    }
    try {
      const { payload, stale } = await getPayload(sel);
      sendJson(res, 200, stale ? { ...payload, stale: true } : payload);
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'pollen_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'pollen',
    configureServer({ middlewares }) {
      middlewares.use('/api/pollen', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/pollen', handler);
    },
  };
}

export const _pollenInternals = {
  parseQuery,
  parseLocationPayload,
  buildPayload,
  buildUpstreamUrl,
  selectionPlaces,
  clearCaches: () => { payloadCache.clear(); inflight.clear(); docFailedAt = -Infinity; },
};
