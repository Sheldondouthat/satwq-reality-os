/**
 * Aviation SIGMET + airport METAR/TAF proxy (keyless).
 *
 * aviationweather.gov serves keyless JSON (no CORS for browsers), so this
 * provider trims and caches it:
 *
 * Routes:
 *   GET /api/sigmets            → {generatedAt, count, sigmets:[...]}
 *   GET /api/airports/metar?ids=KJFK,KEWR → {generatedAt, reports:[...]}
 *   GET /api/airports/taf?ids=KJFK          → {generatedAt, reports:[...]}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd does NOT implement redirect:'error' —
 * no node: imports, no WASM).
 */

const SIGMET_URL = 'https://aviationweather.gov/api/data/isigmet?format=json';
const METAR_URL = 'https://aviationweather.gov/api/data/metar?format=json';
const TAF_URL = 'https://aviationweather.gov/api/data/taf?format=json';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_STATIONS = 20;
const STATION_RE = /^[A-Z0-9]{3,5}$/;
const RAW_CAP = 1_200;
const COORD_CAP = 512;
const USER_AGENT = 'Gods Eye View (public aviation weather context)';

const caches = new Map(); // key -> {at, payload}
const inflight = new Map();

async function fetchJsonCapped(url, signal) {
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
      throw Object.assign(new Error(`awc_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('awc_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function cached(key, loader) {
  const now = Date.now();
  const hit = caches.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.payload);
  const running = inflight.get(key);
  if (running) return running;
  const p = loader()
    .then((payload) => {
      caches.set(key, { at: Date.now(), payload });
      return payload;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

function roundNum(value) {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** 4;
  return Math.round(value * f) / f;
}

function capRaw(value) {
  const text = String(value ?? '');
  return text.length > RAW_CAP ? text.slice(0, RAW_CAP) + '…' : text;
}

export function trimSigmet(item) {
  const coords = Array.isArray(item?.coords) ? item.coords : [];
  return {
    icaoId: String(item?.icaoId ?? ''),
    firId: String(item?.firId ?? ''),
    firName: String(item?.firName ?? ''),
    hazard: String(item?.hazard ?? ''),
    qualifier: String(item?.qualifier ?? ''),
    severity: String(item?.severity ?? ''),
    base: item?.base ?? null,
    top: item?.top ?? null,
    validFrom: item?.validTimeFrom ?? null,
    validTo: item?.validTimeTo ?? null,
    dir: String(item?.dir ?? ''),
    spd: String(item?.spd ?? ''),
    chng: String(item?.chng ?? ''),
    geom: String(item?.geom ?? ''),
    coords: coords
      .slice(0, COORD_CAP)
      .map((c) => ({ lon: roundNum(c?.lon), lat: roundNum(c?.lat) }))
      .filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat)),
    rawSigmet: capRaw(item?.rawSigmet),
  };
}

export function trimSigmetsPayload(upstream) {
  const items = Array.isArray(upstream) ? upstream : [];
  const sigmets = items.map(trimSigmet).filter((s) => s.icaoId && s.coords.length >= 3);
  return {
    generatedAt: new Date().toISOString(),
    count: sigmets.length,
    sigmets,
    source: 'aviationweather.gov (NOAA AWC, keyless)',
  };
}

export function trimMetar(item) {
  return {
    icaoId: String(item?.icaoId ?? ''),
    obsTime: item?.obsTime ?? null,
    temp: item?.temp ?? null,
    dewp: item?.dewp ?? null,
    wdir: item?.wdir ?? null,
    wspd: item?.wspd ?? null,
    wgst: item?.wgst ?? null,
    visib: item?.visib ?? null,
    fltcat: String(item?.fltCat ?? ''),
    cover: String(item?.cover ?? ''),
    lat: item?.lat ?? null,
    lon: item?.lon ?? null,
    name: String(item?.name ?? ''),
    rawOb: capRaw(item?.rawOb),
  };
}

export function trimTaf(item) {
  return {
    icaoId: String(item?.icaoId ?? ''),
    issueTime: item?.issueTime ?? null,
    validTimeFrom: item?.validTimeFrom ?? null,
    validTimeTo: item?.validTimeTo ?? null,
    lat: item?.lat ?? null,
    lon: item?.lon ?? null,
    name: String(item?.name ?? ''),
    rawTAF: capRaw(item?.rawTAF),
  };
}

function parseStations(req) {
  const parsed = new URL(req.url || '', 'http://localhost');
  const raw = String(parsed.searchParams.get('ids') ?? '');
  const stations = raw
    .toUpperCase()
    .split(',')
    .map((s) => s.trim())
    .filter((s) => STATION_RE.test(s))
    .slice(0, MAX_STATIONS);
  return { parsed, stations };
}

function sendJson(res, status, body, cacheControl = 'public, max-age=300') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

async function sigmetHandler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
  try {
    sendJson(res, 200, await cached('sigmets', () =>
      fetchJsonCapped(SIGMET_URL, null).then(trimSigmetsPayload)));
  } catch (error) {
    sendJson(res, error?.status === 502 ? 502 : 500, {
      error: 'sigmets_unavailable',
      detail: error?.message ?? 'unknown',
    }, 'no-store');
  }
}

async function airportHandler(kind, req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
  const { stations } = parseStations(req);
  if (!stations.length)
    return sendJson(res, 400, { error: 'station_ids_required' }, 'no-store');
  const base = kind === 'metar' ? METAR_URL : TAF_URL;
  const key = `${kind}:${stations.join(',')}`;
  try {
    const payload = await cached(key, () =>
      fetchJsonCapped(`${base}&ids=${stations.join(',')}`, null).then((upstream) => {
        const items = Array.isArray(upstream) ? upstream : [];
        const trim = kind === 'metar' ? trimMetar : trimTaf;
        return {
          generatedAt: new Date().toISOString(),
          reports: items.map(trim).filter((r) => r.icaoId),
          source: 'aviationweather.gov (NOAA AWC, keyless)',
        };
      }));
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, error?.status === 502 ? 502 : 500, {
      error: `${kind}_unavailable`,
      detail: error?.message ?? 'unknown',
    }, 'no-store');
  }
}

/** Mount the SIGMET + airport weather proxies. Mirrors the vaac provider shape. */
export function sigmetsProxy() {
  const sigmet = (req, res) => sigmetHandler(req, res);
  const metar = (req, res) => airportHandler('metar', req, res);
  const taf = (req, res) => airportHandler('taf', req, res);

  function install(middlewares) {
    middlewares.use('/api/sigmets', sigmet);
    middlewares.use('/api/airports/metar', metar);
    middlewares.use('/api/airports/taf', taf);
  }

  return {
    name: 'sigmets',
    configureServer({ middlewares }) {
      install(middlewares);
    },
    configurePreviewServer({ middlewares }) {
      install(middlewares);
    },
  };
}

export const _sigmetsInternals = {
  parseStations,
  STATION_RE,
  clearCaches: () => { caches.clear(); inflight.clear(); },
};
