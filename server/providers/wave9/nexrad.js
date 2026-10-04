/**
 * Wave 9 (R2-1) — NEXRAD live radar-site liveness provider.
 *
 * Backlog R2-1 ("NEXRAD live radar"): NOAA's S3 bucket (noaa-nexrad-level2)
 * holds the raw sweeps but the VM's S3 LIST probes get 403 AccessDenied and
 * Level-II binary is not edge-parseable anyway. The honest, keyless, JSON
 * answer is the NWS api.weather.gov `/radar/stations` collection: one GET
 * returns all 208 US radar sites (159 WSR-88D, 45 TDWR, 4 Profiler) as
 * GeoJSON, and every feature carries `latency.levelTwoLastReceivedTime` —
 * the timestamp NWS last received a Level-II volume scan from that radar —
 * plus an `rda` block (mode, operabilityStatus, status, volumeCoveragePattern,
 * transmitter power, alarms, build). That is genuine live radar-site
 * liveness: a health map of the national radar mesh, refreshable every few
 * minutes with a SINGLE subrequest.
 *
 * HONESTY, stated on the payload:
 *  - `lastScan` is the last time *NWS received* Level-II data from the
 *    radar, not a rendered product and not a precipitation measurement.
 *    No imagery is fetched, fabricated, or interpolated.
 *  - `fresh` = lastScan within 15 min (≈1–3 volume scans); `dark` = no
 *    lastScan at all or older than 60 min. Radars in maintenance,
 *    standby, or comms outages read dark — correctly.
 *  - TDWRs report latency too, so they are first-class; Profilers rarely
 *    carry levelTwoLastReceivedTime and read `lastScan: null` (unknown,
 *    never zero-filled).
 *
 * Upstream (verified live 2026-09-29 from the build VM, HTTP 200,
 * content-type application/geo+json, 510 KB):
 *   https://api.weather.gov/radar/stations
 * Keyless, no signup. api.weather.gov REQUIRES a User-Agent header.
 *
 * Routes:
 *   GET /api/nexrad → { generatedAt, stale, count, summary, stations, attribution }
 * Query: ?type=WSR-88D|TDWR|Profiler (filter), ?station=KOKX (single lookup).
 *
 * Pages-safe: global fetch only, capped 1 MB read, redirect:'follow'
 * (workerd supports only 'follow'/'manual'; 'error' throws at the edge —
 * main 2ec4053), no node: imports, no WASM. One upstream request per
 * refresh — far under the Workers subrequest headroom rule.
 */

import { readResponseTextCapped } from '../common/http.js';

const STATIONS_URL = 'https://api.weather.gov/radar/stations';
const USER_AGENT =
  'satwq-reality-os/1.0 (gods-eye-view; NEXRAD radar layer; keyless)';
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 1024 * 1024; // observed 510 KB; generous headroom
const CACHE_TTL_MS = 120_000; // volume scans land every ~5–10 min
const RETRY_COOLDOWN_MS = 60_000;
const STALE_MS = 10 * 60_000;
const FRESH_SEC = 900; // ≤15 min since last Level-II receipt
const DARK_SEC = 3600; // >60 min (or missing) reads dark
const VALID_TYPES = ['WSR-88D', 'TDWR', 'Profiler'];

let docCache = null; // {at, parsed} — one upstream fetch serves ALL query keys
let docInflight = null; // in-flight doc fetch promise
let docFailedAt = -Infinity; // retry gate: only after a failed doc fetch
const payloadCache = new Map(); // query key -> {at, payload} — stale fallback per key
const PAYLOAD_CACHE_MAX = 32;

/** Number(null)===0 guard: null/NaN upstream numerics become null, never 0. */
function numOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null; // Number('')===0 trap
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse one radar-station feature into the published shape. Pure. */
export function parseStationFeature(feature, nowMs) {
  const props = feature?.properties ?? {};
  const coords = feature?.geometry?.coordinates ?? [];
  const lon = numOrNull(coords[0]);
  const lat = numOrNull(coords[1]);
  if (lat == null || lon == null) return null; // unplottable — skipped, counted
  const rdaProps = props?.rda?.properties ?? {};
  const lastScanRaw = props?.latency?.levelTwoLastReceivedTime ?? null;
  const lastScanMs = lastScanRaw == null ? null : Date.parse(lastScanRaw);
  const lastScan =
    lastScanMs != null && Number.isFinite(lastScanMs)
      ? new Date(lastScanMs).toISOString()
      : null;
  const ageSec =
    lastScanMs != null && Number.isFinite(lastScanMs)
      ? Math.max(0, (nowMs - lastScanMs) / 1000)
      : null;
  const elevation = props?.elevation ?? {};
  return {
    id: String(props?.id ?? '').toUpperCase() || null,
    name: typeof props?.name === 'string' ? props.name : null,
    lat,
    lon,
    type: typeof props?.stationType === 'string' ? props.stationType : null,
    elevationM: numOrNull(elevation.value),
    lastScan,
    ageSec: ageSec == null ? null : Math.round(ageSec),
    fresh: ageSec != null && ageSec <= FRESH_SEC,
    dark: ageSec == null || ageSec > DARK_SEC,
    rdaTimestamp:
      typeof props?.rda?.timestamp === 'string' ? props.rda.timestamp : null,
    mode: typeof rdaProps.mode === 'string' ? rdaProps.mode : null,
    operabilityStatus:
      typeof rdaProps.operabilityStatus === 'string'
        ? rdaProps.operabilityStatus
        : null,
    status: typeof rdaProps.status === 'string' ? rdaProps.status : null,
    vcp:
      typeof rdaProps.volumeCoveragePattern === 'string'
        ? rdaProps.volumeCoveragePattern
        : null,
    alarmSummary:
      typeof rdaProps.alarmSummary === 'string' ? rdaProps.alarmSummary : null,
    buildNumber: numOrNull(rdaProps.buildNumber),
    txPowerW: numOrNull(rdaProps?.averageTransmitterPower?.value),
    controlStatus:
      typeof rdaProps.controlStatus === 'string'
        ? rdaProps.controlStatus
        : null,
  };
}

/** Parse the full /radar/stations GeoJSON document. Pure. Throws {status:502} on bad shape. */
export function parseRadarStationsDoc(text, nowMs) {
  const fail = (msg) =>
    Object.assign(new Error(`nexrad_invalid_doc: ${msg}`), { status: 502 });
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw fail('not JSON');
  }
  if (!Array.isArray(doc?.features)) throw fail('missing features[]');
  const stations = [];
  let skipped = 0;
  for (const feature of doc.features) {
    const s = parseStationFeature(feature, nowMs);
    if (s) stations.push(s);
    else skipped++;
  }
  if (stations.length === 0) throw fail('zero parseable stations');
  const byType = {};
  let fresh = 0;
  let dark = 0;
  let withScan = 0;
  for (const s of stations) {
    const t = s.type ?? 'Unknown';
    byType[t] = (byType[t] ?? 0) + 1;
    if (s.fresh) fresh++;
    if (s.dark) dark++;
    if (s.lastScan) withScan++;
  }
  return {
    stations,
    skipped,
    summary: { total: stations.length, byType, fresh, dark, withScan },
  };
}

/** Build the publishable payload from a parsed doc. Pure. */
export function buildNexradPayload(parsed, { nowMs, query }) {
  let stations = parsed.stations;
  let requestedNotFound = false;
  if (query.station) {
    const match = stations.find((s) => s.id === query.station);
    stations = match ? [match] : [];
    requestedNotFound = !match;
  }
  if (query.type) stations = stations.filter((s) => s.type === query.type);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    stale: false,
    count: stations.length,
    requestedNotFound,
    summary: parsed.summary,
    stations,
    attribution:
      'Radar-site liveness: NWS api.weather.gov /radar/stations (keyless, ' +
      'User-Agent identified). lastScan = latency.levelTwoLastReceivedTime — ' +
      'the last time NWS received a Level-II volume scan from the radar. ' +
      'This is site liveness, not a rendered radar product; no imagery is ' +
      'fetched, fabricated, or interpolated. fresh ≤15 min; dark = no ' +
      'receipt or >60 min (maintenance/standby/outage).',
  };
}

function parseQuery(url) {
  const params = new URL(url, 'http://localhost').searchParams;
  const typeRaw = params.get('type');
  let type = null;
  if (typeRaw != null) {
    type = typeRaw.trim().toUpperCase();
    if (type === 'WSR88D') type = 'WSR-88D'; // forgiving alias
    if (!VALID_TYPES.includes(type))
      throw Object.assign(new Error(`nexrad_bad_type: ${typeRaw}`), {
        status: 400,
      });
  }
  const stationRaw = params.get('station');
  let station = null;
  if (stationRaw != null) {
    station = stationRaw.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,4}$/.test(station))
      throw Object.assign(new Error(`nexrad_bad_station: ${stationRaw}`), {
        status: 400,
      });
  }
  return { type, station, key: `${type ?? ''}:${station ?? ''}` };
}

async function fetchUpstream(fetchImpl, endMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(STATIONS_URL, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). api.weather.gov serves
      // this path directly (200, no redirect observed).
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/geo+json, application/json',
      },
    });
    if (!res.ok)
      throw Object.assign(new Error(`nexrad_upstream_${res.status}`), {
        status: 502,
      });
    const text = await readResponseTextCapped(res, BODY_CAP_BYTES); // throws when too large
    return parseRadarStationsDoc(text, endMs); // throws {status:502} on bad shape
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res, status, body, cacheControl = 'public, max-age=120') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

async function getDoc(fetchImpl, nowMs, signal) {
  if (docCache && nowMs - docCache.at < CACHE_TTL_MS) return docCache.parsed;
  signal?.throwIfAborted?.();
  if (!docInflight) {
    // Retry gate fires only after a FAILED doc fetch — a success on one
    // query key must never block a different key (one upstream serves all).
    if (nowMs - docFailedAt < RETRY_COOLDOWN_MS)
      throw new Error('nexrad_retry_later');
    docInflight = fetchUpstream(fetchImpl, nowMs)
      .then((parsed) => {
        docCache = { at: nowMs, parsed };
        docFailedAt = -Infinity;
        return parsed;
      })
      .catch((error) => {
        docFailedAt = nowMs;
        throw error;
      })
      .finally(() => {
        docInflight = null;
      });
  }
  const wait = docInflight;
  if (!signal) return wait;
  const cancelled = new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    const detach = () => signal.removeEventListener('abort', abort);
    wait.then(detach, detach);
  });
  return Promise.race([wait, cancelled]);
}

function rememberPayload(key, payload, nowMs) {
  payloadCache.set(key, { at: nowMs, payload });
  while (payloadCache.size > PAYLOAD_CACHE_MAX) {
    const oldest = payloadCache.keys().next().value;
    payloadCache.delete(oldest);
  }
}

async function getPayload(fetchImpl, query, nowMs, signal) {
  try {
    const parsed = await getDoc(fetchImpl, nowMs, signal);
    const payload = buildNexradPayload(parsed, { nowMs, query });
    rememberPayload(query.key, payload, nowMs);
    return payload;
  } catch (error) {
    // Stale fallback is key-scoped: only serve a payload captured for THIS query.
    const hit = payloadCache.get(query.key);
    if (hit && nowMs - hit.at <= STALE_MS)
      return {
        ...hit.payload,
        generatedAt: new Date(nowMs).toISOString(),
        stale: true,
      };
    throw error;
  }
}

export function nexradProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    try {
      let query;
      try {
        query = parseQuery(req.url);
      } catch (error) {
        return sendJson(
          res,
          400,
          { error: 'nexrad_bad_request', detail: error.message },
          'no-store',
        );
      }
      try {
        const payload = await getPayload(
          fetchImpl,
          query,
          now(),
          controller.signal,
        );
        sendJson(res, 200, payload);
      } catch (error) {
        const upstreamFail =
          error?.status === 502 ||
          error?.name === 'AbortError' ||
          /aborted?|fetch failed/i.test(error?.message ?? '');
        sendJson(
          res,
          upstreamFail ? 502 : 500,
          { error: 'nexrad_unavailable', detail: error?.message ?? 'unknown' },
          'no-store',
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'nexrad',
    configureServer({ middlewares }) {
      middlewares.use('/api/nexrad', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/nexrad', handler);
    },
  };
}

export const _nexradInternals = {
  STATIONS_URL,
  VALID_TYPES,
  FRESH_SEC,
  DARK_SEC,
  numOrNull,
  parseStationFeature,
  parseRadarStationsDoc,
  buildNexradPayload,
  clearCaches: () => {
    docCache = null;
    docInflight = null;
    docFailedAt = -Infinity;
    payloadCache.clear();
  },
};
