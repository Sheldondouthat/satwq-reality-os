/**
 * Wave 6 #31 — NOAA CO-OPS tides proxy (keyless, NOAA public domain).
 *
 * Upstreams (all under https://api.tidesandcurrents.noaa.gov/api/prod/):
 *   water level : datagetter?product=water_level&station={id}&datum=MLLW&date=recent&time_zone=gmt&units=english&format=json
 *                 → {metadata:{id,name,lat,lon}, data:[{t,v,s,f,q}]}
 *   predictions : datagetter?product=predictions&station={id}&datum=MLLW&date=today&time_zone=gmt&units=english&interval=hilo&format=json
 *                 → {predictions:[{t,v,type}]}   type is 'H' or 'L'
 *
 * `datum=` is REQUIRED (the API 400s without it). units=english → feet.
 * Water level cadence is 6 minutes; `date=recent` returns up to 72h.
 *
 * Routes:
 *   GET /api/tides?station=8638610&kind=water_level|predictions|both
 *     → {generatedAt, station, sources:{...}, waterLevel:[...]|null,
 *        predictions:[...]|null}
 *   GET /api/tides?stations=8443970,8518750&kind=water_level|predictions|both
 *     → {generatedAt, kind, count, stations:[per-station snapshots…]}
 *       (added 2026-09-27, branch wave5-recur-stations — station sweep)
 *
 * A 502 is returned only when EVERY requested product fails; partial
 * results are reported honestly per source.
 *
 * Curated multi-station sweep: the STATIONS list below holds 42 CO-OPS
 * stations, every one verified 2026-09-27/28/29 against the upstream's own
 * station-list endpoint
 * (https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/{id}.json).
 * Multi-station mode fetches each station's requested products in parallel;
 * a station whose products ALL fail is reported as {station:{id}, ok:false,
 * error} inside stations[] — one dead station never poisons the sweep.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error'
 * throws at the edge (main 2ec4053) — no node: imports, no WASM).
 *
 * Shapes VERIFIED by live probe from the build VM on 2026-09-27
 * (both endpoints HTTP 200 JSON; no redirect observed on
 * api.tidesandcurrents.noaa.gov).
 */

const COOPS_BASE = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const WATER_LEVEL_TTL_MS = 10 * 60_000;
const PREDICTIONS_TTL_MS = 6 * 60 * 60_000;
const MAX_READINGS = 500;
const USER_AGENT = 'Gods Eye View (public tide context)';
const STATION_RE = /^\d{1,7}$/;
const MAX_MULTI_STATIONS = 10;
// Default station: 8638610 Sewells Point VA (near the user's region).

/**
 * Curated CO-OPS station list. Every ID verified 2026-09-27 against the
 * upstream's own station-list endpoint
 * (api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/{id}.json);
 * names/coords are the live values from those responses.
 */
const STATIONS = [
  { id: '8638610', name: 'Sewells Point', lat: 36.9428, lon: -76.3286, region: 'Virginia' },
  { id: '8443970', name: 'Boston', lat: 42.35389, lon: -71.05028, region: 'Massachusetts' },
  { id: '8518750', name: 'The Battery', lat: 40.700554, lon: -74.01417, region: 'New York' },
  { id: '8724580', name: 'Key West', lat: 24.5557, lon: -81.8079, region: 'Florida' },
  { id: '8728690', name: 'Apalachicola', lat: 29.724445, lon: -84.98055, region: 'Florida' },
  { id: '8761724', name: 'Grand Isle', lat: 29.2633, lon: -89.9567, region: 'Louisiana' },
  { id: '9410170', name: 'San Diego', lat: 32.715557, lon: -117.17667, region: 'California' },
  { id: '9414290', name: 'San Francisco', lat: 37.806305, lon: -122.46589, region: 'California' },
  { id: '9444900', name: 'Port Townsend', lat: 48.11122, lon: -122.759674, region: 'Washington' },
  { id: '8725520', name: 'Fort Myers', lat: 26.647778, lon: -81.87111, region: 'Florida' }, // verified 2026-09-27 recur
  { id: '8661070', name: 'Springmaid Pier', lat: 33.655, lon: -78.9183, region: 'South Carolina' }, // verified 2026-09-27 recur
  { id: '8454000', name: 'Providence', lat: 41.807167, lon: -71.400665, region: 'Rhode Island' }, // verified 2026-09-27 recur
  { id: '8545240', name: 'Philadelphia', lat: 39.933056, lon: -75.14198, region: 'Pennsylvania' }, // verified 2026-09-27 recur
  { id: '8761927', name: 'New Canal Station', lat: 30.027222, lon: -90.113335, region: 'Louisiana' }, // verified 2026-09-27 recur
  { id: '8665530', name: 'Charleston', lat: 32.780834, lon: -79.923615, region: 'South Carolina' }, // verified 2026-09-28 recur
  { id: '1612340', name: 'Honolulu', lat: 21.303333, lon: -157.86453, region: 'Hawaii' }, // verified 2026-09-28 recur
  { id: '9447130', name: 'Seattle', lat: 47.60264, lon: -122.3393, region: 'Washington' }, // verified 2026-09-28 recur
  { id: '8771450', name: 'Galveston Pier 21', lat: 29.31, lon: -94.7933, region: 'Texas' }, // verified 2026-09-28 recur
  { id: '8531680', name: 'Sandy Hook', lat: 40.4669, lon: -74.0094, region: 'New Jersey' }, // verified 2026-09-28 recur
  { id: '8574680', name: 'Baltimore', lat: 39.266693, lon: -76.57831, region: 'Maryland' }, // verified 2026-09-28 recur
  { id: '8723214', name: 'Virginia Key', lat: 25.7314, lon: -80.1618, region: 'Florida' }, // verified 2026-09-28 recur
  { id: '8510560', name: 'Montauk', lat: 41.048332, lon: -71.95944, region: 'New York' }, // verified 2026-09-28 recur
  { id: '9411340', name: 'Santa Barbara', lat: 34.40459, lon: -119.6925, region: 'California' }, // verified 2026-09-28 recur
  { id: '9439040', name: 'Astoria', lat: 46.207306, lon: -123.7683, region: 'Oregon' }, // verified 2026-09-28 recur
  { id: '8735180', name: 'Dauphin Island', lat: 30.25, lon: -88.075, region: 'Alabama' }, // verified 2026-09-29 recur
  { id: '9755371', name: 'San Juan', lat: 18.458944, lon: -66.11642, region: 'Puerto Rico' }, // verified 2026-09-29 recur (mdapi full name "San Juan, La Puntilla, San Juan Bay")
  { id: '9452210', name: 'Juneau', lat: 58.2988, lon: -134.4106, region: 'Alaska' }, // verified 2026-09-29 recur
  { id: '1611400', name: 'Nawiliwili', lat: 21.9544, lon: -159.3561, region: 'Hawaii' }, // verified 2026-09-29 recur
  { id: '9443090', name: 'Neah Bay', lat: 48.370724, lon: -124.601585, region: 'Washington' }, // verified 2026-09-29 recur
  { id: '8413320', name: 'Bar Harbor', lat: 44.392193, lon: -68.20428, region: 'Maine' }, // verified 2026-09-29 recur
  { id: '1630000', name: 'Apra Harbor', lat: 13.443389, lon: 144.65636, region: 'Guam' }, // verified 2026-09-29 recur (mdapi full name "Apra Harbor, Guam")
  { id: '9751639', name: 'Charlotte Amalie', lat: 18.330584, lon: -64.925804, region: 'US Virgin Islands' }, // verified 2026-09-29 recur
  { id: '9450460', name: 'Ketchikan', lat: 55.331944, lon: -131.62611, region: 'Alaska' }, // verified 2026-09-29 recur
  { id: '9419750', name: 'Crescent City', lat: 41.74561, lon: -124.18439, region: 'California' }, // verified 2026-09-29 recur
  { id: '8658120', name: 'Wilmington', lat: 34.2267, lon: -77.9533, region: 'North Carolina' }, // verified 2026-09-29 recur
  { id: '8575512', name: 'Annapolis', lat: 38.983883, lon: -76.480034, region: 'Maryland' }, // verified 2026-09-29 recur
  { id: '8557380', name: 'Lewes', lat: 38.782833, lon: -75.11928, region: 'Delaware' }, // verified 2026-09-29 recur (first Delaware station)
  { id: '8670870', name: 'Fort Pulaski', lat: 32.034695, lon: -80.90303, region: 'Georgia' }, // verified 2026-09-29 recur (first Georgia station)
  { id: '8467150', name: 'Bridgeport', lat: 41.17582, lon: -73.18397, region: 'Connecticut' }, // verified 2026-09-29 recur (first Connecticut station)
  { id: '8729108', name: 'Panama City', lat: 30.149723, lon: -85.664444, region: 'Florida' }, // verified 2026-09-29 recur (mdapi name is Panama City, not Pensacola)
  { id: '9410660', name: 'Los Angeles', lat: 33.72, lon: -118.272, region: 'California' }, // verified 2026-09-29 recur
  { id: '1770000', name: 'Pago Pago', lat: -14.28, lon: -170.69, region: 'American Samoa' }, // verified 2026-09-29 recur (mdapi full name "Pago Pago, American Samoa"; first American Samoa territory station)
];

let cache = null; // {at, key, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function roundNum(value, decimals = 3) {
  if (!isFiniteNum(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function numOrNull(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** CO-OPS times arrive as '2026-09-27 01:41' with time_zone=gmt → parse as UTC. */
function coopsTimeToISO(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

async function fetchJsonCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`tides_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('tides_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

export function parseWaterLevel(upstream) {
  const rows = Array.isArray(upstream?.data) ? upstream.data : [];
  const readings = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const t = coopsTimeToISO(r.t);
    const v = numOrNull(r.v);
    if (!t || !isFiniteNum(v)) continue;
    readings.push({
      time: t,
      feet: roundNum(v),
      quality: String(r.q ?? '') || null,
    });
  }
  return readings.slice(0, MAX_READINGS);
}

export function parsePredictions(upstream) {
  const rows = Array.isArray(upstream?.predictions) ? upstream.predictions : [];
  const preds = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const t = coopsTimeToISO(r.t);
    const v = numOrNull(r.v);
    if (!t || !isFiniteNum(v)) continue;
    const type = String(r.type ?? '').toUpperCase();
    preds.push({
      time: t,
      feet: roundNum(v),
      type: type === 'H' || type === 'L' ? type : null,
    });
  }
  return preds;
}

function waterLevelUrl(station) {
  return `${COOPS_BASE}?product=water_level&station=${station}&datum=MLLW&date=recent&time_zone=gmt&units=english&format=json`;
}

function predictionsUrl(station) {
  return `${COOPS_BASE}?product=predictions&station=${station}&datum=MLLW&date=today&time_zone=gmt&units=english&interval=hilo&format=json`;
}

async function fetchProduct(product, station) {
  const started = Date.now();
  const url =
    product === 'water_level'
      ? waterLevelUrl(station)
      : predictionsUrl(station);
  try {
    const upstream = await fetchJsonCapped(url);
    return {
      key: product,
      ok: true,
      latencyMs: Date.now() - started,
      metadata: upstream?.metadata ?? null,
      readings:
        product === 'water_level'
          ? parseWaterLevel(upstream)
          : parsePredictions(upstream),
    };
  } catch (error) {
    return {
      key: product,
      ok: false,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      readings: [],
    };
  }
}

function buildSnapshot(results, station) {
  const sources = {};
  let waterLevel = null;
  let predictions = null;
  let meta = null;
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      count: r.readings.length,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
    if (r.ok && !meta && r.metadata) meta = r.metadata;
    if (r.key === 'water_level' && r.ok) waterLevel = r.readings;
    if (r.key === 'predictions' && r.ok) predictions = r.readings;
  }
  const latest =
    waterLevel && waterLevel.length ? waterLevel[waterLevel.length - 1] : null;
  return {
    generatedAt: new Date().toISOString(),
    station: {
      id: String(station),
      name: meta?.name ? String(meta.name) : null,
      lat: numOrNull(meta?.lat),
      lon: numOrNull(meta?.lon),
    },
    sources,
    current: latest ? { ...latest, asOf: latest.time } : null,
    waterLevel,
    predictions,
    units: 'feet MLLW',
    attribution: 'NOAA CO-OPS (public domain, keyless)',
  };
}

export function parseQuery(req) {
  const url = new URL(req.url ?? '/api/tides', 'http://localhost');
  const station = url.searchParams.get('station') ?? '8638610';
  const kindRaw = (url.searchParams.get('kind') ?? 'water_level').toLowerCase();
  if (!STATION_RE.test(station))
    throw Object.assign(
      new Error(`tides_bad_station:${station.slice(0, 32)}`),
      { status: 400 },
    );
  const kind =
    kindRaw === 'predictions' || kindRaw === 'both' ? kindRaw : 'water_level';
  const stationsRaw = url.searchParams.get('stations');
  let stations = null;
  if (stationsRaw != null && stationsRaw.trim() !== '') {
    stations = [...new Set(stationsRaw.split(',').map((s) => s.trim()).filter(Boolean))];
    if (stations.length === 0 || stations.length > MAX_MULTI_STATIONS)
      throw Object.assign(new Error(`tides_too_many_stations:${stations.length}`), { status: 400 });
    for (const st of stations) {
      if (!STATION_RE.test(st))
        throw Object.assign(new Error(`tides_bad_station:${st.slice(0, 32)}`), { status: 400 });
    }
  }
  return { station, stations, kind };
}

/** Products to fetch for a kind (shared by single and multi-station paths). */
function productsFor(kind) {
  return kind === 'water_level'
    ? ['water_level']
    : kind === 'predictions'
      ? ['predictions']
      : ['water_level', 'predictions'];
}

/** Multi-station sweep: one entry per station, honest per-station errors. */
async function getMultiSnapshot(stations, kind) {
  const key = `multi:${stations.join(',')}:${kind}`;
  const ttl = kind === 'predictions' ? PREDICTIONS_TTL_MS : WATER_LEVEL_TTL_MS;
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < ttl) return cache.payload;
  if (!inflight) {
    const products = productsFor(kind);
    inflight = Promise.all(
      stations.map(async (station) => {
        const results = await Promise.all(products.map((p) => fetchProduct(p, station)));
        const okOnes = results.filter((r) => r.ok);
        if (okOnes.length === 0) {
          return {
            station: { id: String(station), name: null, lat: null, lon: null },
            ok: false,
            error: results.map((r) => `${r.key}:${r.error}`).join('; '),
          };
        }
        return { ...buildSnapshot(okOnes, station), ok: true };
      }),
    )
      .then((entries) => {
        if (!entries.some((e) => e.ok)) {
          const detail = entries.map((e) => `${e.station.id}:${e.error}`).join('; ');
          throw Object.assign(new Error(`tides_all_upstream_down: ${detail}`), { status: 502 });
        }
        const payload = {
          generatedAt: new Date().toISOString(),
          kind,
          count: entries.length,
          okCount: entries.filter((e) => e.ok).length,
          stations: entries,
          attribution: 'NOAA CO-OPS (public domain, keyless)',
        };
        cache = { at: Date.now(), key, payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

async function getSnapshot(station, kind) {
  const key = `${station}:${kind}`;
  const ttl = kind === 'predictions' ? PREDICTIONS_TTL_MS : WATER_LEVEL_TTL_MS;
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < ttl) return cache.payload;
  if (!inflight) {
    inflight = Promise.all(productsFor(kind).map((p) => fetchProduct(p, station)))
      .then((results) => {
        if (!results.some((r) => r.ok)) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(new Error(`tides_all_upstream_down: ${detail}`), {
            status: 502,
          });
        }
        const payload = buildSnapshot(results, station);
        cache = { at: Date.now(), key, payload };
        return payload;
      })
      .finally(() => {
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

/** Mount the CO-OPS tides proxy. Mirrors the wave-5 provider shape. */
export function tidesProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const { station, stations, kind } = parseQuery(req);
      sendJson(res, 200, stations ? await getMultiSnapshot(stations, kind) : await getSnapshot(station, kind));
    } catch (error) {
      if (error?.status === 400)
        return sendJson(
          res,
          400,
          { error: 'tides_bad_station', detail: error?.message ?? 'unknown' },
          'no-store',
        );
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'tides_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'tides',
    configureServer({ middlewares }) {
      middlewares.use('/api/tides', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/tides', handler);
    },
  };
}

export const _tidesInternals = {
  parseWaterLevel,
  parsePredictions,
  coopsTimeToISO,
  buildSnapshot,
  parseQuery,
  productsFor,
  STATIONS,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
