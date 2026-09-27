/**
 * Radiation map (wave3 sci-fi B #4) — live global background-radiation dots.
 *
 * Upstream: Safecast API (api.safecast.org) — keyless, no auth, CORS-friendly
 * for our server proxy. Verified live 2026-09-27: GET
 * https://api.safecast.org/en-US/measurements?unit=usv&order=desc&limit=N
 * with `Accept: application/json` returns [{id, value, unit, latitude,
 * longitude, captured_at, ...}] with fresh timestamps (minutes old).
 *
 * Retired alternatives (documented, not used):
 *  - uRadMonitor data API (data.uradmonitor.com/api/v1/devices) now requires
 *    X-User-id / X-User-hash auth → keyed, excluded by the NOTHING-paid /
 *    keyless iron constraint. Verified 2026-09-27: {"error":"Authentification failed"}.
 *  - OpenRadiation request.openradiation.net requires an apiKey parameter.
 *    Verified 2026-09-27: {"error":{"code":"100","message":"You must send the apiKey parameter"}}.
 *
 * Serves GET /api/radiation → {
 *   schemaVersion, source, attribution, fetchedAt, stale, unavailable, reason,
 *   points: [{ lat, lon, valueUsvH, capturedAt }]   (bounded, latest-first)
 * }
 *
 * Keyless, global fetch only, capped reads, Pages-safe (no node: imports).
 * Follows the cyclones.js factory pattern.
 *
 * doseBand lives in the client model (src/frontier/wave3/radiation/model.js)
 * and is re-exported here — the server→src direction matches the existing
 * invisibleOceanProxy → src/layers/invisibleOcean/model.js precedent.
 */
import { readResponseTextCapped } from '../common/http.js';
import { doseBand } from '../../../src/frontier/wave3/radiation/model.js';

export { doseBand };

const UPSTREAM_BASE = 'https://api.safecast.org/en-US/measurements';
const USER_AGENT = 'SATWQ Reality OS (public Safecast volunteer radiation context)';
const UPSTREAM_TIMEOUT_MS = 15_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60_000;
const STALE_MS = 60 * 60_000;
const RETRY_COOLDOWN_MS = 60_000;
const MAX_POINTS = 600;
const UPSTREAM_LIMIT = 800;

export function normalizeMeasurement(m) {
  const lat = m?.latitude == null ? NaN : Number(m.latitude);
  const lon = m?.longitude == null ? NaN : Number(m.longitude);
  const value = m?.value == null ? NaN : Number(m.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(value)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (value < 0 || value > 1000) return null; // sanity: µSv/h outside this is instrument error
  const unit = String(m.unit ?? 'usv').toLowerCase();
  // Safecast units: usv (µSv/h) or cpm. Normalize cpm → µSv/h via 0.0027 factor
  // (documented approximation for SBM-20-class tubes; labeled as approximate).
  const valueUsvH = unit === 'cpm' ? value * 0.0027 : value;
  return {
    lat: round4(lat),
    lon: round4(lon),
    valueUsvH: Math.round(valueUsvH * 1000) / 1000,
    unit: unit === 'cpm' ? 'usv~' : 'usv',
    capturedAt: typeof m.captured_at === 'string' ? m.captured_at : null,
  };
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

export function normalizeBatch(payload) {
  if (!Array.isArray(payload)) return [];
  const out = [];
  for (const m of payload) {
    if (out.length >= MAX_POINTS) break;
    const p = normalizeMeasurement(m);
    if (p) out.push(p);
  }
  return out;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': status === 200 ? 'public, max-age=300' : 'no-store',
  });
  res.end(JSON.stringify(payload));
}

export function radiationProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  let cache = null; // { fetchedAt, points }
  let attemptedAt = -Infinity;

  async function refresh(signal) {
    const url = new URL(UPSTREAM_BASE);
    url.search = new URLSearchParams({
      unit: 'usv',
      order: 'desc',
      limit: String(UPSTREAM_LIMIT),
    }).toString();
    const response = await fetchImpl(url.href, {
      signal,
      redirect: 'follow',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw new Error(`radiation_upstream_http_${response.status}`);
    }
    const text = await readResponseTextCapped(response, BODY_CAP_BYTES, signal);
    signal.throwIfAborted();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('radiation_upstream_unparseable');
    }
    const points = normalizeBatch(payload);
    cache = { fetchedAt: now(), points };
    return cache;
  }

  function describe(value, { stale = false, reason = null } = {}) {
    return {
      schemaVersion: 1,
      source: 'Safecast volunteer network (keyless API) via local proxy',
      attribution:
        'Radiation measurements © Safecast contributors (CC0 / public domain ' +
        'where declared). Served as public volunteer sensor metadata.',
      fetchedAt: value?.fetchedAt ?? null,
      stale,
      unavailable: !value,
      reason,
      points: value?.points ?? [],
    };
  }

  async function handler(req, res) {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }
    const fresh = cache && now() - cache.fetchedAt < CACHE_TTL_MS;
    if (fresh) return sendJson(res, 200, describe(cache));
    const staleOk = cache && now() - cache.fetchedAt < STALE_MS;
    if (now() - attemptedAt < RETRY_COOLDOWN_MS) {
      return sendJson(
        res,
        staleOk ? 200 : 503,
        describe(cache, staleOk ? { stale: true } : { reason: 'radiation_upstream_cooldown' }),
      );
    }
    attemptedAt = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const value = await refresh(controller.signal);
      return sendJson(res, 200, describe(value));
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'radiation_upstream_timeout' : String(error?.message ?? error);
      return sendJson(
        res,
        staleOk ? 200 : 503,
        describe(cache, staleOk ? { stale: true, reason } : { reason }),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'radiation',
    configureServer({ middlewares }) {
      middlewares.use('/api/radiation', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/radiation', handler);
    },
  };
}
