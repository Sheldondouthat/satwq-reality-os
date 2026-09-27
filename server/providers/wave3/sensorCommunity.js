/**
 * Wave 3 / Track 2a.3 — Sensor.Community citizen air-quality layer.
 *
 * WHY A PROXY: data.sensor.community caps filter responses at ~96 KB and
 * truncates mid-JSON on wide areas; the provider detects truncation,
 * retries nothing (the cap is upstream), and serves one compact normalized
 * document at /api/air-quality. It also keeps the SDS011 value-type mapping
 * (P1 = PM10, P2 = PM2.5) in one tested place.
 *
 * Upstream: https://data.sensor.community/airrohr/v1/filter/area=<lat>,<lon>,<r_km>
 * (VERIFIED live 2026-09-27). Keyless, volunteer data. Global fetch only;
 * no node:* imports (Pages-safe).
 *
 * Wave 7 extension (#136 sensor.community defensive, #59 wave C): the
 * hourly GLOBAL snapshot https://data.sensor.community/static/v2/data.1h.json
 * is added as a second source (`?source=static`, or automatic fallback in
 * the default `auto` mode). The dump is heavy, so it is fetched with a hard
 * byte cap; truncation throws honestly (502 with a hint) instead of serving
 * half a planet. Sensors are filtered to the requested area locally with a
 * haversine cut, reusing parseSensorRecord (the v2 dump shares the v1
 * filter record schema per sensor.community docs — OBSERVED via docs; the
 * build VM could not reach the static host on 2026-09-27 (curl 000),
 * so the schema match is flagged "needs Worker probe" until confirmed
 * live). `via` in the payload says which source answered.
 *
 * AQI categories use US EPA PM2.5 breakpoints — a MODEL mapping, labeled as
 * such in the payload (`aqiModel`) and in the client legend.
 */
import { readResponseTextCapped } from '../common/http.js';

const UPSTREAM = 'https://data.sensor.community/airrohr/v1/filter/area=';
// Wave-7 defensive second source: hourly global snapshot (#136).
const STATIC_UPSTREAM = 'https://data.sensor.community/static/v2/data.1h.json';
const STATIC_CAP = 16 * 1024 * 1024; // heavy dump — hard cap; truncation throws, never half-served
const STATIC_CACHE_TTL_MS = 30 * 60_000; // snapshot refreshes hourly
const STATIC_STALE_MS = 2 * 60 * 60_000;
const STATIC_MAX_SENSORS = 50_000;
const USER_AGENT = 'satwq-reality-os/1.0 (Sensor.Community public sensor data; contact via repo)';

const CACHE_TTL_MS = 5 * 60_000; // citizen sensors report every ~2-5 min
const STALE_MS = 30 * 60_000;
const RETRY_COOLDOWN_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 20_000;
const TEXT_CAP = 4 * 1024 * 1024;
const MAX_SENSORS = 1500;

/** US EPA PM2.5 (µg/m³, 24h) breakpoints -> AQI category. MODEL, not a measurement. */
export const AQI_BANDS = [
  { max: 12.0, name: 'Good', color: '#3ddc84' },
  { max: 35.4, name: 'Moderate', color: '#ffe14d' },
  { max: 55.4, name: 'USG', color: '#ff9f43' },
  { max: 150.4, name: 'Unhealthy', color: '#ff5a5a' },
  { max: 250.4, name: 'Very unhealthy', color: '#b366ff' },
  { max: Infinity, name: 'Hazardous', color: '#8b1a3d' },
];

/** 1-based AQI category index for a PM2.5 value. */
export function aqiCategory(pm25) {
  if (!Number.isFinite(pm25) || pm25 < 0) return null;
  return AQI_BANDS.findIndex((b) => pm25 <= b.max) + 1;
}

/** Validate the ?source= mode: 'area' | 'static' | 'auto'. Throws {status}. */
export function parseSourceMode(query) {
  const raw = (query.get('source') ?? 'auto').toLowerCase();
  if (raw === 'area' || raw === 'static' || raw === 'auto') return raw;
  throw Object.assign(new Error('air_bad_source'), { status: 400 });
}

/** Great-circle distance in km. Pure. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

/** Keep sensors within area.r km of the area center. Pure. */
export function filterToArea(sensors, area) {
  return (sensors ?? []).filter(
    (s) => haversineKm(area.lat, area.lon, s.lat, s.lon) <= area.r,
  );
}

/** Summarize a normalized sensor list. Pure. */
export function summarizeSensors(sensors) {
  const pm25s = sensors.map((s) => s.pm25).filter((v) => Number.isFinite(v));
  return pm25s.length > 0
    ? {
        count: sensors.length,
        withPm25: pm25s.length,
        avgPm25: pm25s.reduce((a, b) => a + b, 0) / pm25s.length,
        maxPm25: Math.max(...pm25s),
        worstAqi: Math.max(...sensors.map((s) => s.aqi ?? 0)),
      }
    : { count: sensors.length, withPm25: 0, avgPm25: null, maxPm25: null, worstAqi: 0 };
}

/** Validate lat/lon/r query. Throws {status}. */
export function parseArea(query) {
  const lat = Number(query.get('lat'));
  const lon = Number(query.get('lon'));
  const r = Number(query.get('r') ?? '10');
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw Object.assign(new Error('air_bad_lat'), { status: 400 });
  }
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw Object.assign(new Error('air_bad_lon'), { status: 400 });
  }
  if (!Number.isFinite(r) || r < 0.5 || r > 50) {
    throw Object.assign(new Error('air_bad_radius'), { status: 400 });
  }
  return { lat, lon, r: Math.round(r * 10) / 10 };
}

/** Extract PM values from one sensor.community record. Null when unusable. */
export function parseSensorRecord(rec) {
  const loc = rec?.location;
  const lat = Number(loc?.latitude);
  const lon = Number(loc?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const byType = {};
  for (const v of rec?.sensordatavalues ?? []) {
    if (v?.value_type) byType[v.value_type] = Number(v.value);
  }
  const pm25 = byType.P2;
  const pm10 = byType.P1;
  if (!Number.isFinite(pm25) && !Number.isFinite(pm10)) return null;
  const timeMs = Date.parse(rec?.timestamp?.replace(' ', 'T') + 'Z');
  return {
    id: String(rec?.sensor?.id ?? `${lat.toFixed(4)},${lon.toFixed(4)}`),
    lat,
    lon,
    pm25: Number.isFinite(pm25) ? pm25 : null,
    pm10: Number.isFinite(pm10) ? pm10 : null,
    aqi: aqiCategory(pm25),
    timeMs: Number.isFinite(timeMs) ? timeMs : null,
    indoor: loc?.indoor === 1,
  };
}

/** Parse the (possibly truncated) area-API upstream body. Throws on truncation. */
export function parseSensorPayload(text, { maxSensors = MAX_SENSORS } = {}) {
  let docs;
  try {
    docs = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('air_upstream_truncated'), { status: 502 });
  }
  if (!Array.isArray(docs)) throw new Error('air_unexpected_shape');
  const sensors = [];
  for (const rec of docs) {
    const s = parseSensorRecord(rec);
    if (s && !s.indoor) sensors.push(s); // outdoor only: indoor readings skew the haze field
    if (sensors.length >= maxSensors) break;
  }
  return { sensors, summary: summarizeSensors(sensors) };
}

/**
 * Parse the heavy GLOBAL static snapshot body. The dump is fetched under a
 * hard byte cap; if the cap is crossed or the body is not complete JSON,
 * this throws honestly — a half-planet snapshot must never be served as
 * if it were complete. Returns unfiltered normalized sensors (area
 * filtering happens per-request via filterToArea).
 */
export function parseStaticPayload(text, { maxSensors = STATIC_MAX_SENSORS } = {}) {
  let docs;
  try {
    docs = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('air_static_truncated'), { status: 502 });
  }
  if (!Array.isArray(docs))
    throw Object.assign(new Error('air_static_unexpected_shape'), { status: 502 });
  const sensors = [];
  for (const rec of docs) {
    const s = parseSensorRecord(rec);
    if (s && !s.indoor) sensors.push(s);
    if (sensors.length >= maxSensors) break;
  }
  return sensors;
}

function describe(value, { stale = false, reason = null, via = 'area' } = {}) {
  return {
    schemaVersion: 1,
    source: 'Sensor.Community citizen sensors via local proxy',
    via, // 'area' (airrohr filter API) or 'static' (hourly global snapshot, area-filtered locally)
    attribution: 'Sensor data © Sensor.Community contributors (volunteer network).',
    aqiModel: 'US EPA PM2.5 breakpoints mapped to 1-6 categories — estimate, not an official AQI.',
    fetchedAt: value?.fetchedAt ?? null,
    stale,
    unavailable: !value,
    reason,
    area: value?.area ?? null,
    summary: value?.summary ?? null,
    sensors: value?.sensors ?? [],
  };
}

export function sensorCommunityProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  const attemptedAt = new Map();
  // Static-snapshot machinery (global, not per-area): one heavy fetch serves all areas.
  let staticCache = null; // {at, sensors, fetchedAt}
  let staticInflight = null;
  let staticAttemptedAt = -Infinity;

  const areaKey = (area) => `${area.lat.toFixed(2)},${area.lon.toFixed(2)},${area.r}`;

  async function fetchUpstream(area, signal) {
    const url = `${UPSTREAM}${area.lat},${area.lon},${area.r}`;
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`air_upstream_http_${response.status}`);
    }
    const text = await readResponseTextCapped(response, TEXT_CAP, signal);
    signal.throwIfAborted();
    const { sensors, summary } = parseSensorPayload(text);
    return { area, sensors, summary, fetchedAt: now() };
  }

  /** Fetch the hourly global snapshot under a hard byte cap. Throws {status:502} honestly. */
  async function fetchStaticSnapshot(signal) {
    signal.throwIfAborted();
    const response = await fetchImpl(STATIC_UPSTREAM, {
      signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`air_static_http_${response.status}`), { status: 502 });
    }
    let text;
    try {
      text = await readResponseTextCapped(response, STATIC_CAP, signal);
    } catch (error) {
      throw Object.assign(new Error(`air_static_too_large: ${error?.message ?? 'unknown'}`), { status: 502 });
    }
    signal.throwIfAborted();
    return { sensors: parseStaticPayload(text), fetchedAt: now() };
  }

  /** Global static-snapshot cache with inflight dedup and retry cooldown. */
  function acquireStatic(signal) {
    if (staticCache && now() - staticCache.at < STATIC_CACHE_TTL_MS)
      return Promise.resolve({ value: staticCache, stale: false });
    signal.throwIfAborted();
    if (!staticInflight) {
      if (now() - staticAttemptedAt < RETRY_COOLDOWN_MS) throw new Error('air_static_retry_later');
      staticAttemptedAt = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs + 60_000);
      staticInflight = fetchStaticSnapshot(controller.signal)
        .then((snap) => {
          staticCache = { at: now(), ...snap };
          return { value: staticCache, stale: false };
        })
        .finally(() => {
          clearTimeout(timer);
          staticInflight = null;
        });
    }
    const cancelled = new Promise((_, reject) => {
      const abort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      const detach = () => signal.removeEventListener('abort', abort);
      staticInflight.then(detach, detach);
    });
    return Promise.race([staticInflight, cancelled]);
  }

  /** Static snapshot cut to the requested area. */
  async function acquireStaticArea(area, signal) {
    const { value, stale } = await acquireStatic(signal);
    const sensors = filterToArea(value.sensors, area).slice(0, MAX_SENSORS);
    return {
      value: { area, sensors, summary: summarizeSensors(sensors), fetchedAt: value.fetchedAt },
      stale,
      via: 'static',
    };
  }

  async function acquireArea(area, signal) {
    const key = areaKey(area);
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < CACHE_TTL_MS)
      return { value: hit.value, stale: false, via: hit.value?.via ?? 'area' };
    signal.throwIfAborted();
    let op = inflight.get(key);
    if (!op) {
      if (now() - (attemptedAt.get(key) ?? -Infinity) < RETRY_COOLDOWN_MS) {
        throw new Error('air_retry_later');
      }
      attemptedAt.set(key, now());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);
      op = fetchUpstream(area, controller.signal)
        .then((value) => {
          const stamped = { ...value, via: 'area' };
          if (cache.size >= 16) cache.delete(cache.keys().next().value);
          cache.set(key, { value: stamped, fetchedAt: now() });
          return { value: stamped, stale: false, via: 'area' };
        })
        .finally(() => {
          clearTimeout(timer);
          inflight.delete(key);
        });
      inflight.set(key, op);
    }
    const cancelled = new Promise((_, reject) => {
      const abort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      const detach = () => signal.removeEventListener('abort', abort);
      op.then(detach, detach); // both branches resolve: never an unhandled rejection
    });
    return Promise.race([op, cancelled]);
  }

  /**
   * Route by ?source=: 'area' → filter API only; 'static' → global snapshot
   * only (502 on its failure); 'auto' (default) → filter API first, static
   * snapshot as fallback, stale/empty 200 only if both fail.
   */
  async function acquire(area, signal, mode) {
    if (mode === 'area') return acquireArea(area, signal);
    if (mode === 'static') return acquireStaticArea(area, signal);
    try {
      return await acquireArea(area, signal);
    } catch (areaError) {
      // Upstream truncation stays an honest 502 (historic contract — do not swallow it).
      if (areaError?.status === 502) throw areaError;
      try {
        return await acquireStaticArea(area, signal);
      } catch {
        throw areaError; // static fallback failed too: drop to the stale/empty path below
      }
    }
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
      const query = new URL(req.url, 'http://localhost').searchParams;
      let area;
      try {
        area = parseArea(query);
      } catch (error) {
        return json(error.status ?? 400, { error: error.message });
      }
      let mode;
      try {
        mode = parseSourceMode(query);
      } catch (error) {
        return json(error.status ?? 400, { error: error.message });
      }
      try {
        const { value, stale, via } = await acquire(area, controller.signal, mode);
        json(200, describe(value, { stale, via }));
      } catch (error) {
        if (error.status === 502)
          return json(502, {
            error: error.message,
            hint:
              mode === 'static'
                ? 'static snapshot is a heavy global dump; retry without ?source=static or narrow r'
                : 'reduce r',
          });
        // 'auto' and any non-truncation failure: stale-or-empty 200, as before.
        const key = areaKey(area);
        const hit = cache.get(key);
        const usable = hit && now() - hit.fetchedAt <= STALE_MS;
        const staticUsable = staticCache && now() - staticCache.at <= STATIC_STALE_MS;
        if (usable) {
          json(
            200,
            describe(hit.value, {
              stale: true,
              via: hit.value?.via ?? 'area',
              reason: 'Sensor.Community unreachable; showing last sweep.',
            }),
          );
        } else if (staticUsable) {
          const sensors = filterToArea(staticCache.sensors, area).slice(0, MAX_SENSORS);
          json(
            200,
            describe(
              { area, sensors, summary: summarizeSensors(sensors), fetchedAt: staticCache.fetchedAt },
              { stale: true, via: 'static', reason: 'Sensor.Community unreachable; showing last static snapshot.' },
            ),
          );
        } else {
          json(
            200,
            describe(null, { reason: 'Sensor.Community unreachable and no cached sweep exists.' }),
          );
        }
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'sensor-community',
    configureServer({ middlewares }) {
      middlewares.use('/api/air-quality', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/air-quality', handler);
    },
  };
}
