/**
 * Wave 6 — bikeshare aggregation proxy (all keyless, GBFS standard).
 *
 * Aggregates two Lyft GBFS 2.3 systems into one normalized snapshot:
 *
 *   #164 Citi Bike NYC  https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json
 *                        https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_information.json
 *   #165 Bay Wheels SF   https://gbfs.lyft.com/gbfs/2.3/bay/en/station_status.json
 *                        https://gbfs.lyft.com/gbfs/2.3/bay/en/station_information.json
 *
 * One parser serves all Lyft GBFS systems; station_status (live docks)
 * is joined to station_information (names/coords) by station_id.
 *
 * Routes:
 *   GET /api/bikeshare → {generatedAt, systems:{...}, count, stations:[...]}
 *
 * Per-system failures are recorded honestly in `systems.<key>.error`; a 502
 * is returned only when EVERY system fails.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident, no node: imports, no WASM).
 *
 * Probes (2026-09-27): all four GBFS URLs returned HTTP 200 with no
 * redirect (curl, no -L) from the build VM — Citi Bike 2520 stations
 * (status/info id-join 2520/2520), Bay Wheels 636 stations.
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 60_000;
const USER_AGENT = 'Gods Eye View (public bikeshare aggregation)';

const SYSTEMS = [
  {
    key: 'citibike',
    name: 'Citi Bike NYC',
    statusUrl: 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json',
    infoUrl: 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_information.json',
    attribution: 'Citi Bike / Lyft Urban Solutions (GBFS open)',
  },
  {
    key: 'baywheels',
    name: 'Bay Wheels SF',
    statusUrl: 'https://gbfs.lyft.com/gbfs/2.3/bay/en/station_status.json',
    infoUrl: 'https://gbfs.lyft.com/gbfs/2.3/bay/en/station_information.json',
    attribution: 'Bay Wheels / Lyft Urban Solutions (GBFS open)',
  },
];

let cache = null; // {at, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampLatLon(lat, lon) {
  if (!isFiniteNum(lat) || !isFiniteNum(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function roundNum(value, decimals = 5) {
  if (!isFiniteNum(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function finiteOrNull(value) {
  // NOTE: Number(null) === 0, so nulls must be screened before coercion.
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function flag(value) {
  // GBFS booleans are 1/0; some systems use true/false.
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return null;
}

/**
 * Normalize one GBFS station: live availability (status record) joined to
 * static metadata (info record). Keeps the station whenever the info
 * record carries a valid id + coordinates; availability fields degrade to
 * null when the status record is missing.
 */
function trimStation(systemKey, info, statusById) {
  const id = String(info?.station_id ?? '');
  if (!id) return null;
  const ll = clampLatLon(Number(info?.lat), Number(info?.lon));
  if (!ll) return null;
  const s = statusById.get(id);
  return {
    id: `${systemKey}:${id}`,
    system: systemKey,
    name: String(info?.name ?? info?.short_name ?? '').slice(0, 160),
    lat: roundNum(ll.lat),
    lon: roundNum(ll.lon),
    bikes: finiteOrNull(s?.num_bikes_available),
    ebikes: finiteOrNull(s?.num_ebikes_available),
    docks: finiteOrNull(s?.num_docks_available),
    capacity: finiteOrNull(info?.capacity),
    installed: flag(s?.is_installed),
    renting: flag(s?.is_renting),
    returning: flag(s?.is_returning),
    lastReported: Number.isFinite(s?.last_reported)
      ? new Date(s.last_reported * 1000).toISOString()
      : null,
  };
}

/** Parse one GBFS system's station_status + station_information pair. */
function parseGbfsSystem(system, statusJson, infoJson) {
  const statusList = Array.isArray(statusJson?.data?.stations)
    ? statusJson.data.stations
    : [];
  const infoList = Array.isArray(infoJson?.data?.stations)
    ? infoJson.data.stations
    : [];
  const statusById = new Map();
  for (const s of statusList) {
    if (s && s.station_id != null) statusById.set(String(s.station_id), s);
  }
  const stations = [];
  for (const info of infoList) {
    const t = trimStation(system.key, info, statusById);
    if (t) stations.push(t);
  }
  const statusFeedUpdated = Number.isFinite(statusJson?.last_updated)
    ? new Date(statusJson.last_updated * 1000).toISOString()
    : null;
  return {
    key: system.key,
    name: system.name,
    ok: true,
    stationCount: stations.length,
    bikesAvailable: stations.reduce((sum, s) => sum + (s.bikes ?? 0), 0),
    docksAvailable: stations.reduce((sum, s) => sum + (s.docks ?? 0), 0),
    statusFeedUpdated,
    attribution: system.attribution,
    stations,
  };
}

// ——— fetching ———

async function fetchJsonCapped(systemKey, kind, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). All four GBFS URLs
      // verified non-redirecting (HTTP 200, no -L) on 2026-09-27.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(
        new Error(`bikeshare_${systemKey}_${kind}_upstream_${response.status}`),
        { status: 502 },
      );
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(
        new Error(`bikeshare_${systemKey}_${kind}_upstream_too_large`),
        { status: 502 },
      );
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneSystem(system) {
  const started = Date.now();
  try {
    const [statusJson, infoJson] = await Promise.all([
      fetchJsonCapped(system.key, 'status', system.statusUrl),
      fetchJsonCapped(system.key, 'info', system.infoUrl),
    ]);
    const parsed = parseGbfsSystem(system, statusJson, infoJson);
    return { ...parsed, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      key: system.key,
      name: system.name,
      ok: false,
      stationCount: 0,
      bikesAvailable: 0,
      docksAvailable: 0,
      statusFeedUpdated: null,
      attribution: system.attribution,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      stations: [],
    };
  }
}

function buildSnapshot(results) {
  const systems = {};
  const stations = [];
  for (const r of results) {
    systems[r.key] = {
      ok: r.ok,
      name: r.name,
      stationCount: r.stationCount,
      bikesAvailable: r.bikesAvailable,
      docksAvailable: r.docksAvailable,
      statusFeedUpdated: r.statusFeedUpdated,
      attribution: r.attribution,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
    stations.push(...r.stations);
  }
  // Station ids are already prefixed per system, but sort for stability.
  stations.sort((a, b) =>
    a.system < b.system ? -1 : a.system > b.system ? 1 : a.id < b.id ? -1 : 1,
  );
  return {
    generatedAt: new Date().toISOString(),
    systems,
    count: stations.length,
    stations,
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.all(SYSTEMS.map(fetchOneSystem))
      .then((results) => {
        const ok = results.some((r) => r.ok);
        if (!ok) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(
            new Error(`bikeshare_all_upstream_down: ${detail}`),
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

function sendJson(res, status, body, cacheControl = 'public, max-age=60') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-6 bikeshare aggregation proxy. Mirrors the quakes provider shape. */
export function bikeshareProxy() {
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
          error: 'bikeshare_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'bikeshare',
    configureServer({ middlewares }) {
      middlewares.use('/api/bikeshare', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/bikeshare', handler);
    },
  };
}

export const _bikeshareInternals = {
  trimStation,
  parseGbfsSystem,
  buildSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
