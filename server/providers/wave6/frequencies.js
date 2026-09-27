/**
 * Wave 6 — SatNOGS transmitter-database proxy (keyless, Libre Space open).
 *
 * The SatNOGS DB transmitter endpoint is the community "who's transmitting
 * on what frequency" database: downlink/uplink ranges in Hz, modes, baud
 * rates, and liveness flags per satellite transmitter. The full set is
 * ~3.9 MB across paginated pages, so this provider pages through the API
 * (bounded page count), trims each transmitter to globe-sized fields, and
 * caches for 24 hours.
 *
 * Routes:
 *   GET /api/frequencies → {generatedAt, total, shown, truncated, transmitters:[...]}
 *
 * Transmitter shape: {id, satellite, description, type, mode, alive,
 *   downMHz:[low, high], upMHz:[low, high], baud, invert}
 * Frequencies are converted Hz → MHz at 4 decimals.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const UPSTREAM_URL = 'https://db.satnogs.org/api/transmitters/';
const UPSTREAM_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 500;
const MAX_PAGES = 4; // 4 × 500 = 2000 transmitters max per daily refresh
const CACHE_TTL_MS = 24 * 60 * 60_000;
const USER_AGENT = 'Gods Eye View (satellite frequency context)';

let cache = null; // {at, payload}
let inflight = null;

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
      throw Object.assign(new Error(`frequencies_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error?.status === 502) throw error;
    if (error instanceof SyntaxError)
      throw Object.assign(new Error('frequencies_upstream_bad_json'), { status: 502 });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function hzToMhz(value) {
  // NOTE: Number(null) === 0, so nulls must be screened before coercion.
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / 1e6) * 1e4) / 1e4;
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function trimTransmitter(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.uuid ?? '').slice(0, 64);
  if (!id) return null;
  const down = [hzToMhz(raw.downlink_low), hzToMhz(raw.downlink_high)];
  const up = [hzToMhz(raw.uplink_low), hzToMhz(raw.uplink_high)];
  let satellite = null;
  const satRaw = raw?.satellite;
  if (satRaw != null) {
    const satName = typeof satRaw === 'object' ? satRaw.name : satRaw;
    satellite = satName != null ? String(satName).slice(0, 80) : null;
  }
  return {
    id,
    satellite,
    description: String(raw.description ?? '').slice(0, 200),
    type: String(raw.type ?? '').slice(0, 48),
    mode: String(raw.mode ?? '').slice(0, 48),
    alive: raw.alive === true,
    downMHz: down,
    upMHz: up,
    baud: numOrNull(raw.baud),
    invert: raw.invert === true,
  };
}

async function fetchAllTransmitters() {
  const transmitters = [];
  let url = `${UPSTREAM_URL}?page_size=${PAGE_SIZE}`;
  let total = null;
  let pages = 0;
  while (url && pages < MAX_PAGES) {
    pages += 1;
    const data = await fetchJsonCapped(url);
    if (pages === 1 && data && typeof data === 'object') {
      total = Number.isFinite(Number(data.count)) ? Number(data.count) : null;
    }
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const raw of results) {
      const t = trimTransmitter(raw);
      if (t) transmitters.push(t);
    }
    url = typeof data?.next === 'string' ? data.next : null;
  }
  // Live transmitters first, then by downlink frequency ascending.
  transmitters.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    const af = a.downMHz[0] ?? Infinity;
    const bf = b.downMHz[0] ?? Infinity;
    return af - bf;
  });
  return {
    generatedAt: new Date().toISOString(),
    total,
    shown: transmitters.length,
    truncated: url != null,
    transmitters,
    note: 'SatNOGS DB transmitter database (Libre Space, open): who transmits on what frequency. Daily cache; full DB is multi-MB, served paginated.',
    source: 'SatNOGS DB (Libre Space open data)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = fetchAllTransmitters()
      .then((payload) => {
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=86400') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the SatNOGS transmitter proxy. Mirrors the felt provider shape. */
export function frequenciesProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'frequencies_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'frequencies',
    configureServer({ middlewares }) {
      middlewares.use('/api/frequencies', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/frequencies', handler);
    },
  };
}

export const _frequenciesInternals = {
  trimTransmitter,
  fetchAllTransmitters,
  clearCaches: () => { cache = null; inflight = null; },
};
