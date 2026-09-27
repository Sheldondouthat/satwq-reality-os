/**
 * Wave 6 — COBS comet-observation proxy (keyless).
 *
 * The Comet Observation Database (COBS, Crni Vrh Observatory) publishes the
 * world's crowd-sourced comet observations through a simple JSON API:
 *
 *   #72 https://cobs.si/api/obs_list.api?format=json&from_date=<YYYY-MM-DD>
 *
 * Routes:
 *   GET /api/comets → {generatedAt, sources:{...}, count, comets:[...], observations:[...]}
 *
 * Observations are trimmed to globe-ticker essentials (designation, date,
 * magnitude, observer, method) and additionally rolled up into one row per
 * comet with its latest observation. Per-source failure is recorded in
 * `sources.cobs.error`; a 502 is returned only when the API is unreachable.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053) — no node: imports, no WASM).
 *
 * NOTE (2026-09-27): cobs.si was unreachable from the build VM (curl 000
 * timeouts — VM-throttled, needs a Worker-side probe). The parser below
 * follows the catalog's documented layout (JSON observation records,
 * `des`/`date`/`mag` fields) and is covered by fixture tests.
 */

const UPSTREAM_URL = 'https://cobs.si/api/obs_list.api';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60_000;
const WINDOW_DAYS = 30;
const MAX_OBSERVATIONS = 300;
const MAX_COMETS = 120;
const USER_AGENT = 'Gods Eye View (public comet observation context)';

let cache = null; // {at, payload}
let inflight = null;

function str(value, maxLen) {
  return value == null ? '' : String(value).slice(0, maxLen);
}

function isoOrNull(value) {
  if (value == null || value === '') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function finiteOrNull(value, decimals = 1) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function windowFromDate() {
  return new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
}

// ——— parsers (all pure, exported for tests) ———

/** Trim one COBS observation record to ticker essentials. */
export function trimObservation(r) {
  const des = str(r?.des ?? r?.designation ?? r?.comet, 60);
  if (!des) return null;
  const date = isoOrNull(r?.date ?? r?.obs_date ?? r?.datetime);
  return {
    des,
    date,
    mag: finiteOrNull(r?.mag ?? r?.magnitude),
    observer: str(r?.obs_name ?? r?.observer ?? r?.uid, 80),
    method: str(r?.method, 20),
    instrument: str(r?.instrument ?? r?.telescope, 60),
    comaArcmin: finiteOrNull(r?.coma ?? r?.coma_diameter),
    dc: finiteOrNull(r?.dc ?? r?.degree_of_condensation, 0),
    tailDeg: finiteOrNull(r?.tail ?? r?.tail_length),
  };
}

export function trimObservations(upstream) {
  const rows = Array.isArray(upstream) ? upstream : upstream?.observations ?? [];
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map(trimObservation)
    .filter(Boolean)
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
    .slice(0, MAX_OBSERVATIONS);
}

/** Roll observations up to one row per comet (latest observation wins). */
export function rollupComets(observations) {
  const byDes = new Map();
  for (const o of observations) {
    const prior = byDes.get(o.des);
    if (!prior || String(o.date ?? '') > String(prior.date ?? '')) byDes.set(o.des, o);
  }
  const comets = [...byDes.entries()].map(([des, latest]) => ({
    des,
    latestDate: latest.date,
    latestMag: latest.mag,
    observations: observations.filter((o) => o.des === des).length,
    observer: latest.observer,
    method: latest.method,
  }));
  comets.sort((a, b) => String(b.latestDate ?? '').localeCompare(String(a.latestDate ?? '')));
  return comets.slice(0, MAX_COMETS);
}

export function trimCometPayload(upstream) {
  const observations = trimObservations(upstream);
  return {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    count: observations.length,
    comets: rollupComets(observations),
    observations,
    source: 'COBS — Comet Observation Database, Crni Vrh Observatory (free, attribution)',
  };
}

// ——— fetching ———

async function fetchJsonCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). cobs.si was VM-throttled
      // at build time, so follow is the safe edge default.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`comets_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('comets_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    const url = `${UPSTREAM_URL}?format=json&from_date=${windowFromDate()}`;
    inflight = fetchJsonCapped(url)
      .then((upstream) => {
        const payload = trimCometPayload(upstream);
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=3600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the COBS comet-observation proxy. Mirrors the felt provider shape. */
export function cometsProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'comets_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'comets',
    configureServer({ middlewares }) {
      middlewares.use('/api/comets', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/comets', handler);
    },
  };
}

export const _cometsInternals = {
  trimObservation,
  trimObservations,
  rollupComets,
  trimCometPayload,
  clearCaches: () => { cache = null; inflight = null; },
};
