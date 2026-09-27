/**
 * Wave 7 — IOOS ocean observing: Glider DAC missions + sensor stations (keyless).
 *
 * Two IOOS ERDDAP hosts, queried with bounded, paced, sequential requests:
 *
 *   gliders  #142 https://gliders.ioos.us/erddap/tabledap/allDatasets.json
 *            ?datasetID,title,minTime,maxTime,minLatitude,maxLatitude,
 *             minLongitude,maxLongitude
 *            &maxTime>=<now-14d>&orderByDescending("maxTime")&orderByLimit("20")
 *            → active glider missions (curated from the ~1000-dataset index)
 *            then per mission (top 5, sequential):
 *            tabledap/{datasetID}.json?time,latitude,longitude&time>=<now-24h>
 *            → latest reported position (max-time row)
 *
 *   sensors  #143 https://erddap.sensors.ioos.us/erddap/tabledap/allDatasets.json
 *            (same columns)
 *            &maxTime>=<now-7d>&orderByDescending("maxTime")&orderByLimit("40")
 *            → recently-updated sensor datasets (deduped by station)
 *
 * Routes:
 *   GET /api/ioos → {generatedAt, gliders:{...}, sensors:{...}, sources:{...}}
 *
 * The NOAA coastwatch ERDDAP host is rate-limited from some networks (429,
 * catalog appendix); this provider deliberately uses only the IOOS glider
 * and sensor hosts. Every upstream call is sequential (natural pacing),
 * time-bounded, and row-limited; nothing is hammered.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 *
 * Probe notes (2026-09-27, build VM): both tabledap paths verified live —
 * glider index returned 20 active missions sorted by maxTime (e.g.
 * sp028-20260827T1543 @ 2026-09-27T19:59Z); track query for that mission
 * returned 35 rows in 24h with latest (38.457825, -123.428075); sensor
 * index returned 40 rows / 6.6 KB with station bboxes. Glider tabledap was
 * transiently slow on two earlier probes (timeouts, 0 bytes) — the provider
 * treats per-mission track failures as degraded latest:null, never fatal.
 */

const GLIDER_BASE = 'https://gliders.ioos.us/erddap';
const SENSORS_BASE = 'https://erddap.sensors.ioos.us/erddap';
const UPSTREAM_TIMEOUT_MS = 25_000;
const INDEX_CAP_BYTES = 1 * 1024 * 1024;
const TRACK_CAP_BYTES = 256 * 1024;
const CACHE_TTL_MS = 10 * 60_000;
const USER_AGENT = 'Gods Eye View (IOOS glider/sensor context)';

const GLIDER_WINDOW_DAYS = 14;
const GLIDER_INDEX_LIMIT = 20;
const GLIDER_TRACK_MISSIONS = 5; // latest-position hops (sequential = paced)
const GLIDER_TRACK_WINDOW_HOURS = 24;
const SENSOR_WINDOW_DAYS = 7;
const SENSOR_INDEX_LIMIT = 40;
const FORECAST_SKEW_MS = 6 * 3600_000; // maxTime beyond this ⇒ prediction product

const GLIDER_ATTRIBUTION = 'IOOS Glider DAC (open data)';
const SENSORS_ATTRIBUTION = 'IOOS Sensors ERDDAP (open data)';

let cache = null; // {at, payload}
let inflight = null;

function isoDaysAgo(days, nowMs) {
  return new Date(nowMs - days * 24 * 3600_000).toISOString();
}

function isoHoursAgo(hours, nowMs) {
  return new Date(nowMs - hours * 3600_000).toISOString();
}

/** Bounded, sorted dataset-index query against an ERDDAP tabledap/allDatasets. */
export function indexQueryUrl(base, windowDays, limit, nowMs) {
  const cols =
    'datasetID,title,minTime,maxTime,minLatitude,maxLatitude,minLongitude,maxLongitude';
  const q =
    `?${cols}` +
    `&maxTime>=${encodeURIComponent(isoDaysAgo(windowDays, nowMs))}` +
    `&orderByDescending(${encodeURIComponent('"maxTime"')})` +
    `&orderByLimit(${encodeURIComponent(`"${limit}"`)})`;
  return `${base}/tabledap/allDatasets.json${q}`;
}

/** Latest-track query for one glider mission (last 24h of fixes). */
export function trackQueryUrl(datasetId, nowMs) {
  return (
    `${GLIDER_BASE}/tabledap/${encodeURIComponent(datasetId)}.json` +
    `?time,latitude,longitude&time>=${encodeURIComponent(isoHoursAgo(GLIDER_TRACK_WINDOW_HOURS, nowMs))}`
  );
}

export function infoUrl(base, datasetId) {
  return `${base}/info/${encodeURIComponent(datasetId)}/index.html`;
}

/**
 * Parse an ERDDAP tabledap JSON response ({table:{columnNames, rows}})
 * into an array of row objects. Throws on unexpected shapes.
 */
export function parseTabledap(doc) {
  const table = doc?.table;
  const names = table?.columnNames;
  const rows = table?.rows;
  if (!Array.isArray(names) || !Array.isArray(rows)) {
    throw new Error('ioos_unexpected_tabledap');
  }
  return rows.map((row) => {
    const obj = {};
    for (let i = 0; i < names.length; i++) obj[names[i]] = row?.[i] ?? null;
    return obj;
  });
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round4(value) {
  if (value == null) return null;
  return Math.round(value * 10000) / 10000;
}

function parseBbox(row) {
  const minLat = numOrNull(row.minLatitude);
  const maxLat = numOrNull(row.maxLatitude);
  const minLon = numOrNull(row.minLongitude);
  const maxLon = numOrNull(row.maxLongitude);
  if (minLat == null || maxLat == null || minLon == null || maxLon == null) return null;
  return { minLat: round4(minLat), maxLat: round4(maxLat), minLon: round4(minLon), maxLon: round4(maxLon) };
}

function centerOf(row) {
  const bbox = parseBbox(row);
  if (!bbox) return { lat: null, lon: null };
  return {
    lat: round4((bbox.minLat + bbox.maxLat) / 2),
    lon: round4((bbox.minLon + bbox.maxLon) / 2),
  };
}

/** Newest track row by time → {time, lat, lon} or null. */
export function latestTrackPoint(rows) {
  let best = null;
  let bestMs = -Infinity;
  for (const row of rows ?? []) {
    const ms = Date.parse(row?.time);
    if (!Number.isFinite(ms) || ms <= bestMs) continue;
    const lat = numOrNull(row?.latitude);
    const lon = numOrNull(row?.longitude);
    if (lat == null || lon == null) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    bestMs = ms;
    best = { time: new Date(ms).toISOString(), lat: round4(lat), lon: round4(lon) };
  }
  return best;
}

/**
 * Dedupe sensor datasets that mirror the same station (regional mirrors
 * share title + coordinates under different datasetIDs). Keeps the row with
 * the latest maxTime per station key.
 */
export function dedupeSensors(rows, nowMs) {
  const byStation = new Map();
  for (const row of rows ?? []) {
    const id = row?.datasetID != null ? String(row.datasetID) : null;
    if (!id) continue;
    const { lat, lon } = centerOf(row);
    const key = `${String(row.title ?? '').slice(0, 80)}|${lat ?? '?'}|${lon ?? '?'}`;
    const maxTime = row?.maxTime != null ? String(row.maxTime) : null;
    const prior = byStation.get(key);
    if (!prior || (maxTime != null && (prior.maxTime == null || maxTime > prior.maxTime))) {
      const maxMs = maxTime != null ? Date.parse(maxTime) : NaN;
      byStation.set(key, {
        datasetID: id,
        title: String(row.title ?? '').slice(0, 200),
        minTime: row?.minTime != null ? String(row.minTime) : null,
        maxTime,
        lat,
        lon,
        isForecast: Number.isFinite(maxMs) ? maxMs > nowMs + FORECAST_SKEW_MS : null,
        infoUrl: infoUrl(SENSORS_BASE, id),
      });
    }
  }
  return [...byStation.values()].sort((a, b) =>
    String(b.maxTime ?? '') < String(a.maxTime ?? '') ? -1 : 1,
  );
}

async function fetchJsonCapped(url, capBytes, label) {
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
      throw Object.assign(new Error(`ioos_${label}_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error(`ioos_${label}_upstream_too_large`), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGliders(nowMs) {
  const started = Date.now();
  try {
    const indexDoc = await fetchJsonCapped(
      indexQueryUrl(GLIDER_BASE, GLIDER_WINDOW_DAYS, GLIDER_INDEX_LIMIT, nowMs),
      INDEX_CAP_BYTES,
      'gliders',
    );
    const rows = parseTabledap(indexDoc);
    const missions = [];
    // Sequential latest-position hops = paced; a failed hop degrades to latest:null.
    for (const row of rows.slice(0, GLIDER_TRACK_MISSIONS)) {
      const datasetID = row?.datasetID != null ? String(row.datasetID) : null;
      if (!datasetID) continue;
      const mission = {
        datasetID,
        title: String(row.title ?? '').slice(0, 200),
        minTime: row?.minTime != null ? String(row.minTime) : null,
        maxTime: row?.maxTime != null ? String(row.maxTime) : null,
        bbox: parseBbox(row),
        latest: null,
        trackUrl: trackQueryUrl(datasetID, nowMs),
        infoUrl: infoUrl(GLIDER_BASE, datasetID),
      };
      try {
        const trackDoc = await fetchJsonCapped(mission.trackUrl, TRACK_CAP_BYTES, 'gliders');
        mission.latest = latestTrackPoint(parseTabledap(trackDoc));
      } catch {
        mission.latest = null; // degraded, not fatal (noted in probe comments)
      }
      missions.push(mission);
    }
    return {
      ok: true,
      count: missions.length,
      indexRows: rows.length,
      attribution: GLIDER_ATTRIBUTION,
      latencyMs: Date.now() - started,
      missions,
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      indexRows: 0,
      attribution: GLIDER_ATTRIBUTION,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      missions: [],
    };
  }
}

async function fetchSensors(nowMs) {
  const started = Date.now();
  try {
    const indexDoc = await fetchJsonCapped(
      indexQueryUrl(SENSORS_BASE, SENSOR_WINDOW_DAYS, SENSOR_INDEX_LIMIT, nowMs),
      INDEX_CAP_BYTES,
      'sensors',
    );
    const rows = parseTabledap(indexDoc);
    const datasets = dedupeSensors(rows, nowMs);
    return {
      ok: true,
      count: datasets.length,
      indexRows: rows.length,
      attribution: SENSORS_ATTRIBUTION,
      latencyMs: Date.now() - started,
      datasets,
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      indexRows: 0,
      attribution: SENSORS_ATTRIBUTION,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      datasets: [],
    };
  }
}

function buildPayload(gliders, sensors, nowMs) {
  const sources = {};
  for (const [key, r] of [['gliders', gliders], ['sensors', sensors]]) {
    sources[key] = {
      ok: r.ok,
      count: r.count,
      attribution: r.attribution,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    windowDays: { gliders: GLIDER_WINDOW_DAYS, sensors: SENSOR_WINDOW_DAYS },
    gliders: {
      indexUrl: indexQueryUrl(GLIDER_BASE, GLIDER_WINDOW_DAYS, GLIDER_INDEX_LIMIT, nowMs),
      activeMissions: gliders.count,
      indexRows: gliders.indexRows,
      missions: gliders.missions,
    },
    sensors: {
      indexUrl: indexQueryUrl(SENSORS_BASE, SENSOR_WINDOW_DAYS, SENSOR_INDEX_LIMIT, nowMs),
      activeDatasets: sensors.count,
      indexRows: sensors.indexRows,
      datasets: sensors.datasets,
    },
    sources,
    attribution: `${GLIDER_ATTRIBUTION}; ${SENSORS_ATTRIBUTION}.`,
    note:
      'Bounded, sequential ERDDAP queries (paced, never parallel); ' +
      'isForecast flags prediction products whose maxTime runs ahead of now. ' +
      'The NOAA coastwatch ERDDAP host is intentionally not used (rate-limited on some networks).',
  };
}

async function getSnapshot(nowMs) {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = (async () => {
      // Sequential across hosts = paced; never fan out against ERDDAP.
      const gliders = await fetchGliders(nowMs);
      const sensors = await fetchSensors(nowMs);
      if (!gliders.ok && !sensors.ok) {
        throw Object.assign(
          new Error(`ioos_all_upstream_down: gliders:${gliders.error}; sensors:${sensors.error}`),
          { status: 502 },
        );
      }
      const payload = buildPayload(gliders, sensors, nowMs);
      cache = { at: Date.now(), payload };
      return payload;
    })().finally(() => {
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

/** Mount the IOOS glider + sensor ERDDAP proxy. */
export function ioosProxy({ now = () => Date.now() } = {}) {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot(now()));
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        { error: 'ioos_unavailable', detail: error?.message ?? 'unknown' },
        'no-store',
      );
    }
  }

  return {
    name: 'ioos',
    configureServer({ middlewares }) {
      middlewares.use('/api/ioos', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/ioos', handler);
    },
  };
}

export const _ioosInternals = {
  indexQueryUrl,
  trackQueryUrl,
  infoUrl,
  parseTabledap,
  latestTrackPoint,
  dedupeSensors,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
