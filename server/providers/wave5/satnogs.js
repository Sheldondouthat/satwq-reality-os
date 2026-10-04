/**
 * SatNOGS proxy (keyless, three datasets).
 *
 *   GET /api/satnogs?dataset=tle&limit=200
 *     https://db.satnogs.org/api/tle/ — latest TLE sets per satellite.
 *     Trimmed to {noradCatId, name, line1, line2, tleSource, updated}.
 *     (The existing /api/celestrak layer covers general GP data; SatNOGS DB
 *     is the community radio-operator catalog and is NOT duplicated there.)
 *   GET /api/satnogs?dataset=stations
 *     https://network.satnogs.org/api/stations/ — ground stations with
 *     lat/lng and antenna frequency ranges, for globe markers.
 *     {id, name, lat, lng, qthLocator, observations, futureObservations,
 *      lastSeen, antennas:[{band, frequencyLowHz, frequencyHighHz,
 *      antennaTypeName}], status}
 *   GET /api/satnogs?dataset=transmitters&limit=200
 *     https://db.satnogs.org/api/transmitters/ — frequency allocations.
 *     {uuid, noradCatId, description, mode, service, status,
 *      uplinkHz:{low,high}, downlinkHz:{low,high}, alive, updated}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident; final response host pinned per
 * dataset — no node: imports, no WASM).
 */

const DATASETS = {
  tle: { url: 'https://db.satnogs.org/api/tle/', host: 'db.satnogs.org' },
  stations: {
    url: 'https://network.satnogs.org/api/stations/?format=json',
    host: 'network.satnogs.org',
  },
  transmitters: {
    url: 'https://db.satnogs.org/api/transmitters/',
    host: 'db.satnogs.org',
  },
};
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 8 * 1024 * 1024; // TLE dump can be a few MB
const CACHE_TTL_MS = 15 * 60_000;
const USER_AGENT = 'Gods Eye View (SatNOGS ground-station context)';

const cache = new Map(); // dataset -> {at, payload}
const inflight = new Map(); // dataset -> Promise

function pinHost(responseUrl, pinned) {
  let host = '';
  try {
    host = new URL(responseUrl).hostname;
  } catch {
    /* opaque */
  }
  if (host && host !== pinned)
    throw Object.assign(new Error(`satnogs_redirect_off_host:${host}`), {
      status: 502,
    });
}

async function fetchJsonCapped(dataset, signal) {
  const { url, host } = DATASETS[dataset];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`satnogs_upstream_${response.status}`), {
        status: 502,
      });
    pinHost(response.url, host);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('satnogs_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function numOrNull(value) {
  // Number(null)===0 is finite — without this, null coords/ids read as 0.
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundNum(value, decimals) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function trimTleRow(raw) {
  return {
    noradCatId: numOrNull(raw?.norad_cat_id),
    name: String(raw?.tle0 ?? '')
      .replace(/^0\s+/, '')
      .trim(),
    line1: String(raw?.tle1 ?? ''),
    line2: String(raw?.tle2 ?? ''),
    tleSource: String(raw?.tle_source ?? ''),
    updated: raw?.updated ? String(raw.updated) : null,
  };
}

export function trimStation(raw) {
  const lat = numOrNull(raw?.lat);
  const lng = numOrNull(raw?.lng);
  const antennas = (Array.isArray(raw?.antenna) ? raw.antenna : [])
    .filter((a) => a && typeof a === 'object')
    .slice(0, 8)
    .map((a) => ({
      band: String(a.band ?? ''),
      frequencyLowHz: Number.isFinite(Number(a.frequency))
        ? Number(a.frequency)
        : null,
      frequencyHighHz: Number.isFinite(Number(a.frequency_max))
        ? Number(a.frequency_max)
        : null,
      antennaTypeName: String(a.antenna_type_name ?? ''),
    }));
  const observations = numOrNull(raw?.observations) ?? 0;
  const future = numOrNull(raw?.future_observations) ?? 0;
  return {
    id: numOrNull(raw?.id),
    name: String(raw?.name ?? ''),
    lat: lat == null ? null : roundNum(lat, 5),
    lng: lng == null ? null : roundNum(lng, 5),
    qthLocator: String(raw?.qthlocator ?? ''),
    observations,
    futureObservations: future,
    lastSeen: raw?.last_seen ? String(raw.last_seen) : null,
    status:
      raw?.id == null
        ? 'unknown'
        : observations > 0
          ? 'observed'
          : future > 0
            ? 'scheduled'
            : 'idle',
    antennas,
  };
}

export function trimTransmitter(raw) {
  const hz = (v) => numOrNull(v);
  return {
    uuid: String(raw?.uuid ?? ''),
    noradCatId: numOrNull(raw?.norad_cat_id),
    description: String(raw?.description ?? '').slice(0, 200),
    mode: String(raw?.mode ?? ''),
    service: String(raw?.service ?? ''),
    status: String(raw?.status ?? ''),
    alive: raw?.alive === true,
    uplinkHz: { low: hz(raw?.uplink_low), high: hz(raw?.uplink_high) },
    downlinkHz: { low: hz(raw?.downlink_low), high: hz(raw?.downlink_high) },
    updated: raw?.updated ? String(raw.updated) : null,
  };
}

function buildPayload(dataset, upstream) {
  const rows = Array.isArray(upstream) ? upstream : [];
  const base = {
    generatedAt: new Date().toISOString(),
    dataset,
    source: `SatNOGS ${dataset === 'stations' ? 'network' : 'DB'} (keyless)`,
  };
  if (dataset === 'tle') {
    const trimmed = rows
      .map(trimTleRow)
      .filter((r) => r.noradCatId && r.line1 && r.line2);
    return {
      ...base,
      count: trimmed.length,
      rows: trimmed,
      honesty:
        'Latest community-catalogued TLEs; positions are computed, not measured. ' +
        'Complements /api/celestrak (general GP data).',
    };
  }
  if (dataset === 'stations') {
    const trimmed = rows
      .map(trimStation)
      .filter((s) => s.id && Number.isFinite(s.lat) && Number.isFinite(s.lng));
    return {
      ...base,
      count: trimmed.length,
      withAntennas: trimmed.filter((s) => s.antennas.length).length,
      stations: trimmed,
      honesty:
        'Community ground stations; antenna ranges are the station-declared ' +
        'capability, not a live measurement. Status is derived from observation counts.',
    };
  }
  // transmitters
  const trimmed = rows
    .map(trimTransmitter)
    .filter((t) => t.alive && (t.downlinkHz.low || t.uplinkHz.low));
  return {
    ...base,
    count: trimmed.length,
    transmitters: trimmed,
    honesty:
      'Community frequency-allocation records (alive only); treat as reference, ' +
      'verify against the SatNOGS DB before transmitting.',
  };
}

async function getSnapshot(dataset) {
  const now = Date.now();
  const hit = cache.get(dataset);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.payload;
  if (!inflight.has(dataset)) {
    inflight.set(
      dataset,
      fetchJsonCapped(dataset, null)
        .then((upstream) => {
          const payload = buildPayload(dataset, upstream);
          cache.set(dataset, { at: Date.now(), payload });
          return payload;
        })
        .finally(() => {
          inflight.delete(dataset);
        }),
    );
  }
  return inflight.get(dataset);
}

function sendJson(res, status, body, cacheControl = 'public, max-age=300') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

function parseQuery(url) {
  try {
    return new URL(url, 'http://x').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Mount the SatNOGS proxy. Mirrors the nwsAlerts provider shape. */
export function satnogsProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const params = parseQuery(req.url);
      const dataset = (params.get('dataset') ?? '').toLowerCase();
      if (!DATASETS[dataset]) {
        return sendJson(
          res,
          400,
          {
            error: 'usage',
            usage: 'GET /api/satnogs?dataset=tle|stations|transmitters',
            limitNote: 'optional &limit=1..2000 (default 500)',
          },
          'no-store',
        );
      }
      const limit = Math.max(
        1,
        Math.min(
          Number.isFinite(Number.parseInt(params.get('limit') ?? '', 10))
            ? Number.parseInt(params.get('limit'), 10)
            : 500,
          2000,
        ),
      );
      const payload = await getSnapshot(dataset);
      const key = dataset === 'tle' ? 'rows' : dataset;
      return sendJson(res, 200, {
        ...payload,
        limitedTo: Math.min(limit, payload[key].length),
        [key]: payload[key].slice(0, limit),
      });
    } catch (error) {
      sendJson(
        res,
        error?.status === 502 ? 502 : 500,
        {
          error: 'satnogs_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'satnogs',
    configureServer({ middlewares }) {
      middlewares.use('/api/satnogs', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/satnogs', handler);
    },
  };
}

export const _satnogsInternals = {
  trimTleRow,
  trimStation,
  trimTransmitter,
  buildPayload,
  clearCaches: () => {
    cache.clear();
    inflight.clear();
  },
};
