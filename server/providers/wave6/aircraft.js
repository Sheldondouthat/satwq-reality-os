/**
 * Wave 6 — live aircraft aggregation proxy (all keyless ADS-B).
 *
 * Aggregates two keyless ADS-B feeds into one normalized snapshot:
 *
 *   #78 OpenSky Network https://opensky-network.org/api/states/all?lamin=..&lamax=..&lomin=..&lomax=..
 *   #79 adsb.lol        https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm} (bounded radius; /v2/all 503s — not used)
 *
 * Routes:
 *   GET /api/aircraft → {generatedAt, sources:{...}, count, merged, aircraft:[...]}
 *
 * Each source is parsed into the shared shape
 * {icao24, callsign, originCountry, reg, type, lat, lon, altitudeFt, onGround,
 *  speedKts, trackDeg, verticalRateFpm, squawk, lastContact, sources:[keys]}
 * and cross-source duplicates are merged by ICAO24. Per-source failures are
 * recorded honestly in `sources.<key>.error`; a 502 is returned only when
 * EVERY source fails.
 *
 * OpenSky is rate-limited — one bounded bbox per refresh (NA+Europe box),
 * 30 s cache, honest User-Agent. adsb.lol is community-run; the multi-hub
 * radius queries spread the load instead of hammering /v2/all.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident, no node: imports, no WASM).
 *
 * Upstream reachability: NOT verified from this VM (curl 000 to both hosts,
 * 2026-09-27) — flagged VM-throttled, needs Worker-side probe.
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 6 * 1024 * 1024;
const CACHE_TTL_MS = 30_000; // OpenSky rate-limits; don't hammer
const MAX_AIRCRAFT = 2000;
const USER_AGENT = 'Gods Eye View (public ADS-B aggregation)';

const MS_TO_KT = 1.94384;
const M_TO_FT = 3.28084;
const MS_TO_FPM = 196.85;

// One bounded box per OpenSky refresh: NA + Europe in a single fetch.
// (OpenSky docs/catalog note: bounded queries only.)
const OPENSKY_URL = 'https://opensky-network.org/api/states/all?lamin=20&lamax=65&lomin=-130&lomax=40';

// adsb.lol serves bounded radius queries only — a few high-traffic hubs,
// not a global scrape.
const ADSB_LOL_RADIUS_NM = 250;
const ADSB_LOL_HUBS = [
  { name: 'appalachia', lat: 37.27, lon: -80.72 },
  { name: 'nyc', lat: 40.71, lon: -74.0 },
  { name: 'london', lat: 51.47, lon: -0.45 },
  { name: 'tokyo', lat: 35.68, lon: 139.69 },
];

const ADSB_LOL_URLS = ADSB_LOL_HUBS.map(
  (h) => `https://api.adsb.lol/v2/lat/${h.lat}/lon/${h.lon}/dist/${ADSB_LOL_RADIUS_NM}`,
);

const SOURCES = [
  { key: 'opensky', urls: [OPENSKY_URL], parse: parseOpenSky, attribution: 'OpenSky Network (CC BY-NC-SA 4.0, cite IPSN 2014)' },
  { key: 'adsb_lol', urls: ADSB_LOL_URLS, parse: parseAdsbLol, attribution: 'adsb.lol community ADS-B (ODbL 1.0)' },
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

function normalizeAircraft({
  icao24, callsign, originCountry, reg, type, lat, lon,
  altitudeFt, onGround, speedKts, trackDeg, verticalRateFpm, squawk,
  lastContact, source,
}) {
  const hex = String(icao24 ?? '').toLowerCase().trim();
  // NOTE: Number(null) === 0 — nulls must be screened before coercion,
  // otherwise (0,0) slips through as a valid Gulf of Guinea coordinate.
  if (lat == null || lon == null || lat === '' || lon === '') return null;
  const ll = clampLatLon(Number(lat), Number(lon));
  if (!hex || !ll) return null;
  const contactMs = lastContact instanceof Date
    ? lastContact.getTime()
    : typeof lastContact === 'number'
      ? lastContact // OpenSky epoch seconds → handled below
      : Date.parse(lastContact);
  let contactIso = null;
  if (Number.isFinite(contactMs)) {
    // OpenSky carries epoch SECONDS; adsb.lol relative `seen` secs need `now`.
    contactIso = new Date(contactMs < 1e12 ? contactMs * 1000 : contactMs).toISOString();
  }
  return {
    icao24: hex,
    callsign: String(callsign ?? '').trim().slice(0, 16) || null,
    originCountry: String(originCountry ?? '').slice(0, 80) || null,
    reg: String(reg ?? '').trim().slice(0, 16) || null,
    type: String(type ?? '').trim().slice(0, 24) || null,
    lat: roundNum(ll.lat),
    lon: roundNum(ll.lon),
    altitudeFt: finiteOrNull(altitudeFt, 0),
    onGround: typeof onGround === 'boolean' ? onGround : null,
    speedKts: finiteOrNull(speedKts, 1),
    trackDeg: finiteOrNull(trackDeg, 1),
    verticalRateFpm: finiteOrNull(verticalRateFpm, 0),
    squawk: String(squawk ?? '').trim().slice(0, 8) || null,
    lastContact: contactIso,
    sources: [source],
  };
}

/**
 * OpenSky state-vector indices:
 * 0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact (epoch s),
 * 5 longitude, 6 latitude, 7 baro_altitude (m), 8 on_ground, 9 velocity (m/s),
 * 10 true_track, 11 vertical_rate (m/s), 12 sensors, 13 geo_altitude (m),
 * 14 squawk, 15 spi, 16 position_source.
 */
function parseOpenSky(upstream) {
  const states = Array.isArray(upstream?.states) ? upstream.states : [];
  const out = [];
  for (const s of states) {
    if (!Array.isArray(s)) continue;
    const a = normalizeAircraft({
      icao24: s[0],
      callsign: s[1],
      originCountry: s[2],
      reg: null,
      type: null,
      lat: s[6],
      lon: s[5],
      altitudeFt: s[13] != null ? s[13] * M_TO_FT : (s[7] != null ? s[7] * M_TO_FT : null),
      onGround: s[8],
      speedKts: s[9] != null ? s[9] * MS_TO_KT : null,
      trackDeg: s[10],
      verticalRateFpm: s[11] != null ? s[11] * MS_TO_FPM : null,
      squawk: s[14],
      lastContact: s[4],
      source: 'opensky',
    });
    if (a) out.push(a);
  }
  return out;
}

/**
 * adsb.lol /v2/lat/lon/dist response:
 * {ac:[{hex, type, flight, r, t, alt_baro, gs, track, lat, lon, squawk, seen}], now, msg, ...}
 * alt_baro may be the string 'ground'.
 */
function parseAdsbLol(upstream, nowMs = Date.now()) {
  const ac = Array.isArray(upstream?.ac) ? upstream.ac : [];
  const out = [];
  for (const p of ac) {
    if (!p || typeof p !== 'object') continue;
    const seen = Number(p.seen);
    const altRaw = p.alt_baro === 'ground' ? null : p.alt_baro;
    const a = normalizeAircraft({
      icao24: p.hex,
      callsign: p.flight,
      originCountry: null,
      reg: p.r,
      type: p.t,
      lat: p.lat,
      lon: p.lon,
      altitudeFt: altRaw != null ? altRaw : null,
      onGround: p.alt_baro === 'ground' ? true : null,
      speedKts: p.gs,
      trackDeg: p.track,
      verticalRateFpm: p.baro_rate != null ? p.baro_rate * MS_TO_FPM : null,
      squawk: p.squawk,
      lastContact: Number.isFinite(seen) ? new Date(nowMs - seen * 1000) : null,
      source: 'adsb_lol',
    });
    if (a) out.push(a);
  }
  return out;
}

/**
 * Merge reports for the same airframe by ICAO24. The fresher report wins
 * the position fields; missing callsign/reg/type are backfilled from the
 * other source; source keys are unioned.
 */
function dedupeAircraft(records) {
  const byIcao = new Map();
  for (const r of records) {
    const prior = byIcao.get(r.icao24);
    if (!prior) {
      byIcao.set(r.icao24, { ...r, sources: [...r.sources] });
      continue;
    }
    for (const s of r.sources) if (!prior.sources.includes(s)) prior.sources.push(s);
    const rTime = Date.parse(r.lastContact ?? '');
    const pTime = Date.parse(prior.lastContact ?? '');
    const rNewer = Number.isFinite(rTime) && (!Number.isFinite(pTime) || rTime > pTime);
    if (rNewer) {
      const keep = {
        callsign: prior.callsign, reg: prior.reg, type: prior.type,
        originCountry: prior.originCountry, squawk: prior.squawk,
      };
      Object.assign(prior, r, { sources: prior.sources });
      for (const [k, v] of Object.entries(keep)) if (prior[k] == null) prior[k] = v;
    } else {
      for (const k of ['callsign', 'reg', 'type', 'originCountry', 'squawk']) {
        if (prior[k] == null && r[k] != null) prior[k] = r[k];
      }
    }
  }
  return [...byIcao.values()].slice(0, MAX_AIRCRAFT);
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
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...extraHeaders },
    });
    if (!response.ok)
      throw Object.assign(new Error(`aircraft_${sourceKey}_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error(`aircraft_${sourceKey}_upstream_too_large`), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneSource(source) {
  const started = Date.now();
  try {
    const bodies = await Promise.all(source.urls.map((u) => fetchJsonCapped(source.key, u)));
    const records = [];
    for (const body of bodies) records.push(...source.parse(body));
    return {
      key: source.key,
      ok: true,
      count: records.length,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      aircraft: records,
    };
  } catch (error) {
    return {
      key: source.key,
      ok: false,
      count: 0,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      aircraft: [],
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
    all.push(...r.aircraft);
  }
  const aircraft = dedupeAircraft(all);
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: aircraft.length,
    merged: all.length - aircraft.length,
    aircraft,
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
          throw Object.assign(new Error(`aircraft_all_upstream_down: ${detail}`), { status: 502 });
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

function sendJson(res, status, body, cacheControl = 'public, max-age=30') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-6 aircraft aggregation proxy. Mirrors the wave-5 quakes shape. */
export function aircraftProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'aircraft_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'aircraft',
    configureServer({ middlewares }) {
      middlewares.use('/api/aircraft', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/aircraft', handler);
    },
  };
}

export const _aircraftInternals = {
  parseOpenSky,
  parseAdsbLol,
  normalizeAircraft,
  dedupeAircraft,
  buildSnapshot,
  ADSB_LOL_HUBS,
  ADSB_LOL_URLS,
  clearCaches: () => { cache = null; inflight = null; },
};
