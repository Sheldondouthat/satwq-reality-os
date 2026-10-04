/**
 * Wave 6 — live ship/AIS vessel aggregation proxy (all keyless).
 *
 * Aggregates three keyless AIS feeds into one normalized snapshot:
 *
 *   #81 aiscast      https://ais.openwaters.io/v1/vessels?bbox=.. (GeoJSON, sub-min)
 *   #82 Digitraffic  https://meri.digitraffic.fi/api/ais/v1/locations (GeoJSON, 60 s; requires gzip + `Digitraffic-User` header, CC BY 4.0)
 *   #83 EuRIS        https://eurisportal.eu/api/v3/tracks/bounding-box (European inland tracks; attribution string required)
 *
 * Routes:
 *   GET /api/ships → {generatedAt, sources:{...}, count, merged, ships:[...]}
 *
 * Each source is parsed into the shared shape
 * {mmsi, imo, name, lat, lon, speedKts, courseDeg, headingDeg, navStatus,
 *  shipType, draughtM, destination, lastUpdate, sources:[keys]}
 * and cross-source duplicates are merged by MMSI. Per-source failures are
 * recorded honestly in `sources.<key>.error`; a 502 is returned only when
 * EVERY source fails.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident, no node: imports, no WASM).
 *
 * Upstream reachability: NOT verified from this VM (curl 000 to all three
 * hosts, 2026-09-27) — flagged VM-throttled, needs Worker-side probe.
 * EuRIS bounding-box parameter names are unverified (VM-throttled); a wrong
 * guess surfaces as an honest per-source failure, not a provider failure.
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 8 * 1024 * 1024; // Digitraffic all-Finland GeoJSON is large
const CACHE_TTL_MS = 2 * 60_000;
const MAX_SHIPS = 1500;
const USER_AGENT = 'Gods Eye View (public AIS aggregation)';
const DIGITRAFFIC_USER = 'GodsEyeView/1.0';

const SOURCES = [
  {
    key: 'aiscast',
    urls: ['https://ais.openwaters.io/v1/vessels?bbox=-15,35,40,72'],
    parse: parseAiscast,
    attribution: 'aiscast / OpenWaters (per-source attribution embedded)',
    headers: {},
  },
  {
    key: 'digitraffic',
    urls: ['https://meri.digitraffic.fi/api/ais/v1/locations'],
    parse: parseDigitraffic,
    attribution: 'Fintraffic Digitraffic Marine AIS (CC BY 4.0)',
    // Digitraffic requires a Digitraffic-User header and prefers gzip.
    headers: {
      'Digitraffic-User': DIGITRAFFIC_USER,
      'Accept-Encoding': 'gzip',
    },
  },
  {
    key: 'euris',
    urls: [
      'https://eurisportal.eu/api/v3/tracks/bounding-box?minX=-15&minY=35&maxX=40&maxY=72',
    ],
    parse: parseEuRis,
    attribution: 'EuRIS inland waterway tracks (attribution string required)',
    headers: {},
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

function roundNum(value, decimals = 4) {
  if (!isFiniteNum(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function finiteOrNull(value, decimals = 4) {
  // NOTE: Number(null) === 0, so nulls must be screened before coercion.
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? roundNum(n, decimals) : null;
}

/** MMSI is a 9-digit numeric identity; anything else is junk. */
function normalizeMmsi(value) {
  const s = String(value ?? '').replace(/\D/g, '');
  return /^\d{9}$/.test(s) ? s : null;
}

function normalizeShip({
  mmsi,
  imo,
  name,
  lat,
  lon,
  speedKts,
  courseDeg,
  headingDeg,
  navStatus,
  shipType,
  draughtM,
  destination,
  lastUpdate,
  source,
}) {
  const id = normalizeMmsi(mmsi);
  // NOTE: Number(null) === 0 — nulls must be screened before coercion,
  // otherwise (0,0) slips through as a valid Gulf of Guinea coordinate.
  if (lat == null || lon == null || lat === '' || lon === '') return null;
  const ll = clampLatLon(Number(lat), Number(lon));
  if (!id || !ll) return null;
  const timeMs =
    lastUpdate instanceof Date
      ? lastUpdate.getTime()
      : typeof lastUpdate === 'number'
        ? lastUpdate
        : Date.parse(lastUpdate);
  const imoDigits =
    String(imo ?? '')
      .replace(/\D/g, '')
      .slice(0, 10) || null;
  return {
    mmsi: id,
    imo: imoDigits,
    name:
      String(name ?? '')
        .trim()
        .slice(0, 80) || null,
    lat: roundNum(ll.lat),
    lon: roundNum(ll.lon),
    speedKts: finiteOrNull(speedKts, 1),
    courseDeg: finiteOrNull(courseDeg, 1),
    headingDeg: finiteOrNull(headingDeg, 0),
    navStatus: String(navStatus ?? '').slice(0, 60) || null,
    shipType: String(shipType ?? '').slice(0, 60) || null,
    draughtM: finiteOrNull(draughtM, 1),
    destination:
      String(destination ?? '')
        .trim()
        .slice(0, 80) || null,
    lastUpdate: Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : null,
    sources: [source],
  };
}

function geoJsonFeatures(upstream) {
  if (Array.isArray(upstream?.features)) return upstream.features;
  if (Array.isArray(upstream)) return upstream;
  return [];
}

/**
 * aiscast: GeoJSON FeatureCollection. Feature coords are [lon, lat];
 * identity may live in properties.mmsi or the feature id.
 */
function parseAiscast(upstream) {
  const out = [];
  for (const f of geoJsonFeatures(upstream)) {
    const p = f?.properties ?? {};
    const c = f?.geometry?.coordinates;
    const s = normalizeShip({
      mmsi: p.mmsi ?? p.MMSI ?? f?.id,
      imo: p.imo ?? p.IMO,
      name: p.name ?? p.shipName ?? p.vesselName,
      lat: p.lat ?? c?.[1],
      lon: p.lon ?? p.lng ?? c?.[0],
      speedKts: p.speed ?? p.sog ?? p.speedKnots,
      courseDeg: p.course ?? p.cog ?? p.courseOverGround,
      headingDeg: p.heading,
      navStatus: p.navStatus ?? p.status ?? p.navigationalStatus,
      shipType: p.shipType ?? p.type ?? p.vesselType,
      draughtM: p.draught ?? p.draft,
      destination: p.destination,
      lastUpdate: p.lastUpdate ?? p.timestamp ?? p.updated,
      source: 'aiscast',
    });
    if (s) out.push(s);
  }
  return out;
}

/**
 * Digitraffic meri.digitraffic.fi/api/ais/v1/locations:
 * GeoJSON FeatureCollection; identity in properties.mmsi, speed in knots
 * (sog), course (cog), timestampExternal for the position fix.
 */
function parseDigitraffic(upstream) {
  const out = [];
  for (const f of geoJsonFeatures(upstream)) {
    const p = f?.properties ?? {};
    const c = f?.geometry?.coordinates;
    const s = normalizeShip({
      mmsi: p.mmsi,
      imo: p.imo,
      name: p.name ?? p.shipName,
      lat: p.lat ?? c?.[1],
      lon: p.lon ?? p.lng ?? c?.[0],
      speedKts: p.sog ?? p.speed,
      courseDeg: p.cog ?? p.course,
      headingDeg: p.heading,
      navStatus: p.navStat ?? p.navStatus,
      shipType: p.shipType ?? p.type,
      draughtM: p.draught ?? p.draft,
      destination: p.destination,
      lastUpdate: p.timestampExternal ?? p.timestamp ?? p.lastUpdate,
      source: 'digitraffic',
    });
    if (s) out.push(s);
  }
  return out;
}

/**
 * EuRIS inland tracks: defensive parse — accepts {tracks:[...]}, a bare
 * array, or GeoJSON. EuRIS tracks are anonymized inland vessels.
 */
function parseEuRis(upstream) {
  const items = Array.isArray(upstream?.tracks)
    ? upstream.tracks
    : Array.isArray(upstream)
      ? upstream
      : geoJsonFeatures(upstream);
  const out = [];
  for (const item of items) {
    const p = item?.properties ?? item ?? {};
    const c = item?.geometry?.coordinates;
    const s = normalizeShip({
      mmsi: p.mmsi ?? p.MMSI,
      imo: p.imo,
      name: p.name ?? p.shipName ?? p.vesselName,
      lat: p.lat ?? p.latitude ?? c?.[1],
      lon: p.lon ?? p.lng ?? p.longitude ?? c?.[0],
      speedKts: p.speed ?? p.sog ?? p.speedKnots,
      courseDeg: p.course ?? p.cog,
      headingDeg: p.heading,
      navStatus: p.navStatus ?? p.status,
      shipType: p.shipType ?? p.type ?? p.vesselType,
      draughtM: p.draught ?? p.draft,
      destination: p.destination,
      lastUpdate: p.lastUpdate ?? p.timestamp ?? p.updated ?? p.time,
      source: 'euris',
    });
    if (s) out.push(s);
  }
  return out;
}

/**
 * Merge reports for the same vessel by MMSI. The fresher report wins the
 * position fields; missing metadata is backfilled; source keys unioned.
 */
function dedupeShips(records) {
  const byMmsi = new Map();
  for (const r of records) {
    const prior = byMmsi.get(r.mmsi);
    if (!prior) {
      byMmsi.set(r.mmsi, { ...r, sources: [...r.sources] });
      continue;
    }
    for (const s of r.sources)
      if (!prior.sources.includes(s)) prior.sources.push(s);
    const rTime = Date.parse(r.lastUpdate ?? '');
    const pTime = Date.parse(prior.lastUpdate ?? '');
    const rNewer =
      Number.isFinite(rTime) && (!Number.isFinite(pTime) || rTime > pTime);
    if (rNewer) {
      const keep = {
        imo: prior.imo,
        name: prior.name,
        shipType: prior.shipType,
        destination: prior.destination,
        draughtM: prior.draughtM,
      };
      Object.assign(prior, r, { sources: prior.sources });
      for (const [k, v] of Object.entries(keep))
        if (prior[k] == null) prior[k] = v;
    } else {
      for (const k of [
        'imo',
        'name',
        'shipType',
        'destination',
        'draughtM',
        'navStatus',
      ]) {
        if (prior[k] == null && r[k] != null) prior[k] = r[k];
      }
    }
  }
  return [...byMmsi.values()].slice(0, MAX_SHIPS);
}

// ——— fetching ———

async function fetchJsonCapped(sourceKey, url, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). Upstream redirect behavior
      // was NOT verified from this VM (curl 000, 2026-09-27) — flagged
      // VM-throttled, needs Worker-side probe.
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...extraHeaders,
      },
    });
    if (!response.ok)
      throw Object.assign(
        new Error(`ships_${sourceKey}_upstream_${response.status}`),
        { status: 502 },
      );
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error(`ships_${sourceKey}_upstream_too_large`), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneSource(source) {
  const started = Date.now();
  try {
    const bodies = await Promise.all(
      source.urls.map((u) => fetchJsonCapped(source.key, u, source.headers)),
    );
    const records = [];
    for (const body of bodies) records.push(...source.parse(body));
    return {
      key: source.key,
      ok: true,
      count: records.length,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      ships: records,
    };
  } catch (error) {
    return {
      key: source.key,
      ok: false,
      count: 0,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      ships: [],
    };
  }
}

function buildSnapshot(results) {
  const sources = {};
  const all = [];
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      count: r.count,
      attribution: r.attribution,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
    all.push(...r.ships);
  }
  const ships = dedupeShips(all);
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: ships.length,
    merged: all.length - ships.length,
    ships,
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.all(SOURCES.map(fetchOneSource))
      .then((results) => {
        const ok = results.some((r) => r.ok);
        if (!ok) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(new Error(`ships_all_upstream_down: ${detail}`), {
            status: 502,
          });
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

function sendJson(res, status, body, cacheControl = 'public, max-age=120') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-6 ships aggregation proxy. Mirrors the wave-5 quakes shape. */
export function shipsProxy() {
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
          error: 'ships_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'ships',
    configureServer({ middlewares }) {
      middlewares.use('/api/ships', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/ships', handler);
    },
  };
}

export const _shipsInternals = {
  parseAiscast,
  parseDigitraffic,
  parseEuRis,
  normalizeShip,
  normalizeMmsi,
  dedupeShips,
  buildSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
