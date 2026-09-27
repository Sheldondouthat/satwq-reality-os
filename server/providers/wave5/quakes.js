/**
 * Wave 5 — global quake aggregation proxy (all keyless).
 *
 * Aggregates five quake feeds into one normalized snapshot:
 *
 *   #95 USGS   https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson
 *   #100 JMA   https://www.jma.go.jp/bosai/quake/data/list.json
 *   #101 BMKG  https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json
 *   #102 GeoNet https://api.geonet.org.nz/quake?MMI=3
 *   #97 EMSC FDSN https://seismicportal.eu/fdsnws/event/1/query?format=json&limit=5&minmag=5
 *
 * Routes:
 *   GET /api/quakes → {generatedAt, sources:{...}, quakes:[...]}
 *
 * Each source is parsed into the shared shape
 * {id, lat, lon, depthKm, mag, place, time, sources:[keys]} and cross-source
 * duplicates are merged by time+location proximity. Per-source failures are
 * recorded honestly in `sources.<key>.error`; a 502 is returned only when
 * EVERY source fails.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident, no node: imports, no WASM).
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 3 * 60_000;
const MAX_QUAKES = 500;
const USER_AGENT = 'Gods Eye View (public quake aggregation)';

// Dedupe windows: same physical event reported by 2+ catalogs.
const DEDUPE_TIME_MS = 120_000;
const DEDUPE_KM = 50;
const DEDUPE_MAG_TOL = 0.8;

const SOURCES = [
  { key: 'usgs', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson', parse: parseUsgs, attribution: 'USGS (public domain GeoJSON)' },
  { key: 'jma', url: 'https://www.jma.go.jp/bosai/quake/data/list.json', parse: parseJma, attribution: 'Japan Meteorological Agency (attribution)' },
  { key: 'bmkg', url: 'https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json', parse: parseBmkg, attribution: 'BMKG Indonesia (public)' },
  { key: 'geonet', url: 'https://api.geonet.org.nz/quake?MMI=3', parse: parseGeonet, attribution: 'GeoNet / GNS Science (attribution)' },
  { key: 'emsc', url: 'https://seismicportal.eu/fdsnws/event/1/query?format=json&limit=5&minmag=5', parse: parseEmsc, attribution: 'EMSC (free non-commercial)' },
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

function normalizeQuake({ id, lat, lon, depthKm, mag, place, time, source }) {
  const ll = clampLatLon(Number(lat), Number(lon));
  if (!id || !ll) return null;
  const timeMs = time instanceof Date
    ? time.getTime()
    : typeof time === 'number'
      ? time // USGS feeds carry epoch millis, not ISO strings
      : Date.parse(time);
  if (!Number.isFinite(timeMs)) return null;
  return {
    id: String(id),
    lat: roundNum(ll.lat),
    lon: roundNum(ll.lon),
    depthKm: finiteOrNull(depthKm, 1),
    mag: finiteOrNull(mag, 1),
    place: String(place ?? '').slice(0, 240),
    time: new Date(timeMs).toISOString(),
    sources: [source],
  };
}

/** Haversine distance, km. */
function haversineKm(aLat, aLon, bLat, bLon) {
  const r = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h =
    s1 * s1 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * s2 * s2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Merge quakes that describe the same physical event across catalogs:
 * |Δt| ≤ 120 s, distance ≤ 50 km, |Δmag| ≤ 0.8. The merged entry keeps the
 * fields of the highest-magnitude report and unions the source keys.
 */
function dedupeQuakes(quakes) {
  const ordered = [...quakes].sort((a, b) => {
    const t = Date.parse(b.time) - Date.parse(a.time);
    if (t !== 0) return t;
    return (b.mag ?? -9) - (a.mag ?? -9);
  });
  const merged = [];
  for (const q of ordered) {
    const qTime = Date.parse(q.time);
    const hit = merged.find((m) => {
      if (Math.abs(Date.parse(m.time) - qTime) > DEDUPE_TIME_MS) return false;
      if (haversineKm(m.lat, m.lon, q.lat, q.lon) > DEDUPE_KM) return false;
      if (m.mag != null && q.mag != null && Math.abs(m.mag - q.mag) > DEDUPE_MAG_TOL) return false;
      return true;
    });
    if (hit) {
      for (const s of q.sources) if (!hit.sources.includes(s)) hit.sources.push(s);
      // Prefer the richer report for id/fields when this report has higher mag.
      if ((q.mag ?? -9) > (hit.mag ?? -9)) {
        hit.id = q.id;
        hit.lat = q.lat;
        hit.lon = q.lon;
        hit.depthKm = q.depthKm ?? hit.depthKm;
        hit.mag = q.mag;
        hit.place = q.place || hit.place;
        hit.time = q.time;
      }
    } else {
      merged.push({ ...q, sources: [...q.sources] });
    }
  }
  return merged.slice(0, MAX_QUAKES);
}

// ——— source parsers (all pure, exported for tests) ———

function parseUsgs(upstream) {
  const features = Array.isArray(upstream?.features) ? upstream.features : [];
  const out = [];
  for (const f of features) {
    const p = f?.properties ?? {};
    const c = f?.geometry?.coordinates;
    const q = normalizeQuake({
      id: f?.id ? `usgs:${f.id}` : null,
      lat: c?.[1],
      lon: c?.[0],
      depthKm: c?.[2],
      mag: p.mag,
      place: p.place ?? p.title,
      time: p.time,
      source: 'usgs',
    });
    if (q) out.push(q);
  }
  return out;
}

/** JMA `cod` looks like "+35.5+140.4-40000/": lat, lon, depth in metres (negative = below ground). */
function parseJmaCoord(cod) {
  if (typeof cod !== 'string' || !cod) return null;
  const m = cod.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+)?\/?$/);
  if (!m) return null;
  return {
    lat: Number(m[1]),
    lon: Number(m[2]),
    depthKm: m[3] != null ? Math.abs(Number(m[3])) / 1000 : null,
  };
}

function parseJma(upstream) {
  if (!Array.isArray(upstream)) return [];
  // Same event appears as several bulletins (same eid); keep the final one.
  const byEid = new Map();
  for (const e of upstream) {
    if (!e || typeof e !== 'object') continue;
    const eid = String(e.eid ?? '');
    if (!eid) continue;
    const prior = byEid.get(eid);
    const ser = Number(e.ser);
    const priorSer = prior ? Number(prior.ser) : -1;
    if (!prior || ser > priorSer || (ser === priorSer && String(e.ctt ?? '') > String(prior.ctt ?? ''))) {
      byEid.set(eid, e);
    }
  }
  const out = [];
  for (const [eid, e] of byEid) {
    const coord = parseJmaCoord(e.cod);
    if (!coord) continue; // intensity-only bulletins carry no hypocenter
    const q = normalizeQuake({
      id: `jma:${eid}`,
      lat: coord.lat,
      lon: coord.lon,
      depthKm: coord.depthKm,
      mag: e.mag === '' || e.mag == null ? null : Number(e.mag),
      place: e.en_anm || e.anm,
      time: e.at,
      source: 'jma',
    });
    if (q) out.push(q);
  }
  return out;
}

function parseBmkg(upstream) {
  const g = upstream?.Infogempa?.gempa;
  if (!g || typeof g !== 'object') return [];
  const coords = String(g.Coordinates ?? '').split(',');
  const depthMatch = String(g.Kedalaman ?? '').match(/[\d.]+/);
  const q = normalizeQuake({
    id: `bmkg:${g.DateTime ?? g.Tanggal ?? 'latest'}`,
    lat: coords[0],
    lon: coords[1],
    depthKm: depthMatch ? Number(depthMatch[0]) : null,
    mag: g.Magnitude,
    place: g.Wilayah,
    time: g.DateTime,
    source: 'bmkg',
  });
  return q ? [q] : [];
}

function parseGeonet(upstream) {
  const features = Array.isArray(upstream?.features) ? upstream.features : [];
  const out = [];
  for (const f of features) {
    const p = f?.properties ?? {};
    const c = f?.geometry?.coordinates;
    const q = normalizeQuake({
      id: p.publicID ? `geonet:${p.publicID}` : null,
      lat: c?.[1],
      lon: c?.[0],
      depthKm: p.depth,
      mag: p.magnitude,
      place: p.locality,
      time: p.time,
      source: 'geonet',
    });
    if (q) out.push(q);
  }
  return out;
}

function parseEmsc(upstream) {
  const features = Array.isArray(upstream?.features) ? upstream.features : [];
  const out = [];
  for (const f of features) {
    const p = f?.properties ?? {};
    const c = f?.geometry?.coordinates;
    const q = normalizeQuake({
      id: p.unid ? `emsc:${p.unid}` : null,
      lat: p.lat ?? c?.[1],
      lon: p.lon ?? c?.[0],
      depthKm: p.depth,
      mag: p.mag,
      place: p.flynn_region,
      time: p.time,
      source: 'emsc',
    });
    if (q) out.push(q);
  }
  return out;
}

// ——— fetching ———

async function fetchJsonCapped(sourceKey, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). All five quake upstreams
      // are pinned hosts verified non-redirecting (2026-09-27 probe).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`quakes_${sourceKey}_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error(`quakes_${sourceKey}_upstream_too_large`), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneSource(source) {
  const started = Date.now();
  try {
    const upstream = await fetchJsonCapped(source.key, source.url);
    const quakes = source.parse(upstream);
    return {
      key: source.key,
      ok: true,
      count: quakes.length,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      quakes,
    };
  } catch (error) {
    return {
      key: source.key,
      ok: false,
      count: 0,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      quakes: [],
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
    all.push(...r.quakes);
  }
  const quakes = dedupeQuakes(all);
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: quakes.length,
    merged: all.length - quakes.length,
    quakes,
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
          throw Object.assign(new Error(`quakes_all_upstream_down: ${detail}`), { status: 502 });
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

function sendJson(res, status, body, cacheControl = 'public, max-age=180') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-5 quakes aggregation proxy. Mirrors the nwsAlerts provider shape. */
export function quakesProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      sendJson(res, error?.status === 502 ? 502 : 500, {
        error: 'quakes_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'quakes',
    configureServer({ middlewares }) {
      middlewares.use('/api/quakes', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/quakes', handler);
    },
  };
}

export const _quakesInternals = {
  parseUsgs,
  parseJma,
  parseJmaCoord,
  parseBmkg,
  parseGeonet,
  parseEmsc,
  normalizeQuake,
  dedupeQuakes,
  haversineKm,
  buildSnapshot,
  clearCaches: () => { cache = null; inflight = null; },
};
