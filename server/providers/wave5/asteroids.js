/**
 * Wave 5 — JPL close-approach asteroid proxy (keyless).
 *
 * Catalog #65:
 *   https://ssd-api.jpl.nasa.gov/cad.api?dist-max=0.05&date-min=2026-09-01&date-max=2026-10-31
 *
 * RELATION TO /api/neo (server/providers/wave3/neo.js): the wave-3 NEO
 * provider already fetches this exact upstream (NASA/JPL CNEOS
 * Close-Approach Data API) and transforms rows with transformCadRow().
 * This provider REUSES that machinery (parseCadParams + fetchApproaches —
 * no second upstream pipeline, no duplicated parsing) and exposes the
 * catalog-#65 shape: pass-through date-min/date-max/dist-max with
 * validation, trimmed to
 *   {generatedAt, count, approaches:[{des,cd,distAu,distLd,vRelKms,h}]}.
 *
 * Routes:
 *   GET /api/asteroids → {generatedAt, count, approaches:[...]}
 *   GET /api/asteroids?date-min=2026-09-01&date-max=2026-10-31&dist-max=0.05
 *
 * Miss distances are geocentric close-approach distances; 1 LD = 384,400 km.
 * H is the published absolute magnitude — NOT a diameter (see /api/neo for
 * the albedo-estimated diameter range).
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, default redirect handling — workerd does NOT implement
 * redirect:'error' per the 2026-09-27 edge incident, no node: imports,
 * no WASM).
 */

import { parseCadParams, fetchApproaches } from '../wave3/neo.js';

const CACHE_TTL_MS = 3600_000; // ~1h: close-approach catalogs are slow-changing
const CACHE_MAX_KEYS = 32;

const cache = new Map(); // paramKey → { at, payload }
const inflight = new Map(); // paramKey → Promise<payload>

function paramKey(params) {
  return `${params.dateMin}|${params.dateMax}|${params.distMaxAu}`;
}

function round(value, decimals) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Trim a wave3 transformCadRow() record to the catalog-#65 field set. */
export function trimApproach(row) {
  return {
    des: String(row?.des ?? ''),
    cd: row?.closeApproachUtc ?? null,
    distAu: round(row?.distAu, 6),
    distLd: round(row?.distLd, 3),
    vRelKms: round(row?.vRelKms, 2),
    h: row?.absMagH ?? null,
  };
}

function buildPayload(params, approaches) {
  return {
    generatedAt: new Date().toISOString(),
    count: approaches.length,
    window: {
      from: params.dateMin,
      to: params.dateMax,
      distMaxAu: params.distMaxAu,
    },
    source: 'NASA/JPL CNEOS Close-Approach Data API (keyless)',
    approaches: approaches.map(trimApproach),
  };
}

async function getSnapshot(params) {
  const key = paramKey(params);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.payload;
  if (!inflight.has(key)) {
    inflight.set(
      key,
      fetchApproaches(params)
        .then((approaches) => {
          const payload = buildPayload(params, approaches);
          cache.set(key, { at: Date.now(), payload });
          if (cache.size > CACHE_MAX_KEYS) {
            for (const [k, v] of cache) {
              if (Date.now() - v.at >= CACHE_TTL_MS) cache.delete(k);
            }
          }
          return payload;
        })
        .finally(() => {
          inflight.delete(key);
        }),
    );
  }
  return inflight.get(key);
}

function sendJson(res, status, body, cacheControl = 'public, max-age=1800') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the Wave 5 asteroids proxy. Mirrors the nwsAlerts provider shape. */
export function asteroidsProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      // connect semantics: the /api/asteroids prefix is already stripped.
      const query = new URL(String(req.url || '/'), 'http://localhost')
        .searchParams;
      sendJson(res, 200, await getSnapshot(parseCadParams(query)));
    } catch (error) {
      const status =
        error?.status === 502 ? 502 : error?.status === 400 ? 400 : 500;
      sendJson(
        res,
        status,
        {
          error:
            error?.status === 400
              ? 'asteroids_bad_request'
              : 'asteroids_upstream_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'asteroids',
    configureServer({ middlewares }) {
      middlewares.use('/api/asteroids', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/asteroids', handler);
    },
  };
}

export const _asteroidsInternals = {
  trimApproach,
  buildPayload,
  clearCaches: () => {
    cache.clear();
    inflight.clear();
  },
};
