/**
 * IOC Sea Level Monitoring (legacy API ONLY) provider (keyless).
 *
 * Upstream (VERIFIED 2026-09-27):
 *   station list: https://www.ioc-sealevelmonitoring.org/service.php?query=stationlist&format=json
 *   observations: https://www.ioc-sealevelmonitoring.org/service.php?query=data&code=<code>&format=json
 *                 → [{ slevel, stime, sensor }]
 * Legacy service.php only. The v2 API requires a key — never touched here.
 *
 * Physics honesty: `trendMPerH` is DERIVED (least-squares slope over the
 * last 6 h of observations, in metres per hour). It describes recent water
 * movement at the gauge, NOT a tsunami detection — genuine tsunami alerts
 * come from dedicated warning centres, never from this layer.
 *
 * Consumer contract:
 *   GET /api/sealevel[?stations=code1,code2] → JSON
 *   {
 *     fetchedAt, ttlMs, stale,
 *     selection: 'stratified' | 'custom',
 *     stations: [{
 *       code, location, country, lat, lon, type,
 *       latest: { t, level } | null,   // metres above gauge datum
 *       trendMPerH, samples, status: 'ok'|'nodata'|'error'
 *     }],
 *     unavailable, reason
 *   }
 *
 * Default selection: one recently-reporting live station per 30°×30° ocean
 * cell (deterministic stratified sample, ≤24 stations). Custom selection:
 * ?stations= comma list validated against ^[a-z0-9_-]{1,24}$.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, no node: imports, no WASM).
 */

const SERVICE_BASE = 'https://www.ioc-sealevelmonitoring.org/service.php';
const UPSTREAM_TIMEOUT_MS = 20_000;
const LIST_CAP_BYTES = 2 * 1024 * 1024;
const DATA_CAP_BYTES = 256 * 1024;
const USER_AGENT = 'SATWQ Reality OS (public IOC sea-level context)';
const CACHE_TTL_MS = 10 * 60 * 1000;
const LIST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STATIONS = 24;
const TREND_WINDOW_H = 6;
const CODE_RE = /^[a-z0-9_-]{1,24}$/;

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': status === 200 ? 'public, max-age=300' : 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function fetchJsonCapped(fetchImpl, url, maxBytes, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`sealevel_upstream_${response.status}`), {
        status: 502,
      });
    const text = await response.text();
    if (text.length > maxBytes)
      throw Object.assign(new Error('sealevel_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function parseIocTime(stime) {
  // "2026-09-26 12:10:00" → ms epoch (treated as UTC).
  const ms = Date.parse(`${String(stime).trim().replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Deterministic stratified pick: one most-recently-reporting live station
 * per 30°×30° cell, capped at MAX_STATIONS. Pure function — unit-tested.
 */
export function stratifyStations(stationList, maxStations = MAX_STATIONS) {
  const cells = new Map();
  for (const s of stationList || []) {
    if (s?.status !== 1) continue;
    if (s.Lat == null || s.Lon == null) continue; // Number(null) === 0 — reject explicitly
    const lat = Number(s.Lat);
    const lon = Number(s.Lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${Math.floor((lat + 90) / 30)}:${Math.floor((lon + 180) / 30)}`;
    const statday = s.statday
      ? Date.parse(String(s.statday).replace(' ', 'T'))
      : 0;
    const prev = cells.get(key);
    if (!prev || (Number.isFinite(statday) && statday > prev._ts)) {
      cells.set(key, { ...s, _ts: Number.isFinite(statday) ? statday : 0 });
    }
  }
  return [...cells.values()]
    .sort((a, b) => b._ts - a._ts)
    .slice(0, maxStations)
    .map(({ _ts, ...rest }) => rest);
}

/**
 * Least-squares slope of level over time → metres per hour.
 * Pure function — unit-tested.
 */
export function trendPerHour(observations) {
  const pts = (observations || [])
    .map((o) => ({ t: parseIocTime(o.stime), v: Number(o.slevel) }))
    .filter((p) => p.t !== null && Number.isFinite(p.v));
  if (pts.length < 3) return null;
  const cutoff = pts[pts.length - 1].t - TREND_WINDOW_H * 3600_000;
  const win = pts.filter((p) => p.t >= cutoff);
  if (win.length < 3) return null;
  const t0 = win[0].t;
  const xs = win.map((p) => (p.t - t0) / 3600_000);
  const ys = win.map((p) => p.v);
  const n = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  return Math.round(slope * 10000) / 10000;
}

/** Normalize one station + its observations into the contract row. */
export function normalizeStation(station, observations) {
  const base = {
    code: station.code,
    location: station.Location || station.code,
    country: station.country || null,
    lat: station.Lat == null ? null : Number(station.Lat),
    lon: station.Lon == null ? null : Number(station.Lon),
    type: station.type || null,
  };
  const rows = (observations || [])
    .map((o) => ({
      t: o.stime,
      ms: parseIocTime(o.stime),
      v: Number(o.slevel),
    }))
    .filter((r) => r.ms !== null && Number.isFinite(r.v))
    .sort((a, b) => a.ms - b.ms);
  if (!rows.length)
    return {
      ...base,
      latest: null,
      trendMPerH: null,
      samples: 0,
      status: 'nodata',
    };
  const latest = rows[rows.length - 1];
  return {
    ...base,
    latest: {
      t: new Date(latest.ms).toISOString(),
      level: Math.round(latest.v * 1000) / 1000,
    },
    trendMPerH: trendPerHour(observations),
    samples: rows.length,
    status: 'ok',
  };
}

export function iocSealevelProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  let cache = null; // { key, at, payload }
  let listCache = null; // { at, stations }

  async function stationList() {
    const now = Date.now();
    if (listCache && now - listCache.at < LIST_TTL_MS)
      return listCache.stations;
    const list = await fetchJsonCapped(
      fetchImpl,
      `${SERVICE_BASE}?query=stationlist&format=json`,
      LIST_CAP_BYTES,
      UPSTREAM_TIMEOUT_MS,
    );
    if (!Array.isArray(list))
      throw Object.assign(new Error('sealevel_list_malformed'), {
        status: 502,
      });
    listCache = { at: now, stations: list };
    return list;
  }

  async function fetchStationData(station) {
    try {
      const obs = await fetchJsonCapped(
        fetchImpl,
        `${SERVICE_BASE}?query=data&code=${encodeURIComponent(
          station.code,
        )}&format=json`,
        DATA_CAP_BYTES,
        UPSTREAM_TIMEOUT_MS,
      );
      return normalizeStation(
        station,
        Array.isArray(obs) ? obs.slice(-48) : [],
      );
    } catch {
      return { ...normalizeStation(station, []), status: 'error' };
    }
  }

  async function getSnapshot(customCodes) {
    const key = customCodes ? `custom:${customCodes.join(',')}` : 'stratified';
    const now = Date.now();
    if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS)
      return { ...cache.payload, stale: false };
    const list = await stationList();
    let selected;
    let selection;
    if (customCodes) {
      const wanted = new Set(customCodes);
      selected = list.filter((s) => wanted.has(String(s.code).toLowerCase()));
      selection = 'custom';
    } else {
      selected = stratifyStations(list);
      selection = 'stratified';
    }
    if (!selected.length) {
      if (cache && cache.key === key) return { ...cache.payload, stale: true };
      throw Object.assign(new Error('sealevel_no_stations'), { status: 502 });
    }
    const results = await Promise.allSettled(
      selected.map((s) => fetchStationData(s)),
    );
    const stations = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { ...normalizeStation(selected[i], []), status: 'error' },
    );
    const anyOk = stations.some((s) => s.status === 'ok');
    if (!anyOk) {
      if (cache && cache.key === key) return { ...cache.payload, stale: true };
      throw Object.assign(new Error('sealevel_upstream_unavailable'), {
        status: 502,
      });
    }
    const payload = {
      fetchedAt: now,
      ttlMs: CACHE_TTL_MS,
      stale: false,
      selection,
      stations,
      unavailable: false,
      reason: null,
    };
    cache = { key, at: now, payload };
    return payload;
  }

  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' });
    let customCodes = null;
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const s = parsed.searchParams.get('stations');
      if (s) {
        customCodes = [
          ...new Set(
            s
              .split(',')
              .map((c) => c.trim().toLowerCase())
              .filter((c) => CODE_RE.test(c)),
          ),
        ].slice(0, MAX_STATIONS);
        if (!customCodes.length)
          return sendJson(res, 400, { error: 'sealevel_bad_station_codes' });
      }
    } catch {
      return sendJson(res, 400, { error: 'sealevel_bad_request' });
    }
    try {
      sendJson(res, 200, await getSnapshot(customCodes));
    } catch {
      sendJson(res, 502, { error: 'sealevel_upstream_unavailable' });
    }
  }

  return {
    name: 'ioc-sealevel',
    configureServer({ middlewares }) {
      middlewares.use('/api/sealevel', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sealevel', handler);
    },
  };
}
