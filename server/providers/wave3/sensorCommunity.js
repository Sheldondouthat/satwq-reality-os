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
 * AQI categories use US EPA PM2.5 breakpoints — a MODEL mapping, labeled as
 * such in the payload (`aqiModel`) and in the client legend.
 */
import { readResponseTextCapped } from '../common/http.js';

const UPSTREAM = 'https://data.sensor.community/airrohr/v1/filter/area=';
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

/** Parse the (possibly truncated) upstream body. Throws on truncation. */
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
  const pm25s = sensors.map((s) => s.pm25).filter((v) => Number.isFinite(v));
  const summary =
    pm25s.length > 0
      ? {
          count: sensors.length,
          withPm25: pm25s.length,
          avgPm25: pm25s.reduce((a, b) => a + b, 0) / pm25s.length,
          maxPm25: Math.max(...pm25s),
          worstAqi: Math.max(...sensors.map((s) => s.aqi ?? 0)),
        }
      : { count: sensors.length, withPm25: 0, avgPm25: null, maxPm25: null, worstAqi: 0 };
  return { sensors, summary };
}

function describe(value, { stale = false, reason = null } = {}) {
  return {
    schemaVersion: 1,
    source: 'Sensor.Community citizen sensors via local proxy',
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

  async function fetchUpstream(area, signal) {
    const url = `${UPSTREAM}${area.lat},${area.lon},${area.r}`;
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
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

  async function acquire(area, signal) {
    const key = `${area.lat.toFixed(2)},${area.lon.toFixed(2)},${area.r}`;
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < CACHE_TTL_MS) return { value: hit.value, stale: false };
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
          if (cache.size >= 16) cache.delete(cache.keys().next().value);
          cache.set(key, { value, fetchedAt: now() });
          return { value, stale: false };
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
      try {
        const { value, stale } = await acquire(area, controller.signal);
        json(200, describe(value, { stale }));
      } catch (error) {
        if (error.status === 502) return json(502, { error: error.message, hint: 'reduce r' });
        const key = `${area.lat.toFixed(2)},${area.lon.toFixed(2)},${area.r}`;
        const hit = cache.get(key);
        const usable = hit && now() - hit.fetchedAt <= STALE_MS;
        json(
          200,
          usable
            ? describe(hit.value, { stale: true, reason: 'Sensor.Community unreachable; showing last sweep.' })
            : describe(null, { reason: 'Sensor.Community unreachable and no cached sweep exists.' }),
        );
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
