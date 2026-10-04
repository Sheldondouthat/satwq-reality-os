/**
 * Invisible Ocean (F13) — server proxy for WSPRnet + PSK Reporter spots.
 *
 * WHY A PROXY: neither wsprnet.org nor retrieve.pskreporter.info sends
 * CORS headers (verified 2026-09-26), so browsers cannot fetch them directly.
 * This provider fetches both upstreams server-side, parses them with the
 * pure parsers in src/layers/invisibleOcean/model.js, normalizes to canonical
 * spots, and serves one bounded JSON document at /api/invisible-ocean/spots.
 *
 * Keyless, no new dependencies, global fetch only. Follows the cyclones.js
 * factory pattern: export function invisibleOceanProxy() -> { name,
 * configureServer, configurePreviewServer }.
 */
import { readResponseTextCapped } from './common/http.js';
import {
  parsePskXml,
  parseWsprHtml,
  normalizeSpot,
  SPOT_TTL_MS,
} from '../../src/layers/invisibleOcean/model.js';

const PSK_URL =
  'https://retrieve.pskreporter.info/query?flowStartSeconds=-900&rptlimit=1500&encap=2&rronly=1';
const WSPR_URL =
  'https://www.wsprnet.org/olddb?mode=html&band=all&limit=300&sortby=time';

const CACHE_TTL_MS = 120_000; // refresh at most every 2 minutes
const STALE_MS = 15 * 60_000; // serve stale cache up to 15 minutes
const RETRY_COOLDOWN_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
const TEXT_CAP = 4 * 1024 * 1024; // 4 MB per upstream document
const MAX_SPOTS = 800; // served to the client (client renders <= 350)
const USER_AGENT =
  'Gods Eye View InvisibleOcean/1.0 (public volunteer RF metadata; contact via repo)';

function invalid(message) {
  return new Error(message || 'invalid_invisible_ocean_data');
}

function describe(value, { stale = false, reason = null } = {}) {
  return {
    schemaVersion: 1,
    source: 'WSPRnet + PSK Reporter (volunteer spots) via local proxy',
    attribution:
      'Spot data © WSPRnet contributors and PSK Reporter contributors; ' +
      'served as public volunteer metadata. No message content is collected.',
    fetchedAt: value?.fetchedAt ?? null,
    stale,
    unavailable: !value,
    reason,
    providers: value?.providers ?? {
      pskreporter: { error: 'no data yet' },
      wsprnet: { error: 'no data yet' },
    },
    spots: value?.spots ?? [],
  };
}

export function parseSpotPayload(reports, now = Date.now()) {
  if (!Array.isArray(reports)) throw invalid('reports_not_array');
  const cutoff = now - 2 * SPOT_TTL_MS; // keep a margin past the client fade TTL
  const spots = [];
  for (const raw of reports) {
    const spot = normalizeSpot(raw);
    if (!spot) continue;
    if (spot.timeMs < cutoff || spot.timeMs > now + 600_000) continue;
    spots.push(spot);
    if (spots.length >= MAX_SPOTS * 2) break;
  }
  spots.sort((a, b) => b.timeMs - a.timeMs);
  return spots.slice(0, MAX_SPOTS);
}

/** Fixed official endpoints; one shared bounded refresh, no user destinations. */
export function invisibleOceanProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  let cache = null; // { providers, spots, fetchedAt }
  let operation = null;
  let attemptedAt = -Infinity;

  async function upstreamText(url, signal) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xml,text/xml,*/*',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`upstream_http_${response.status}`);
    }
    const text = await readResponseTextCapped(response, TEXT_CAP, signal);
    signal.throwIfAborted();
    return text;
  }

  async function fetchProvider(name, url, parse, signal) {
    try {
      const text = await upstreamText(url, signal);
      const { reports } = parse(text, now());
      const spots = parseSpotPayload(reports, now());
      return { name, ok: true, spots, count: spots.length };
    } catch (error) {
      return {
        name,
        ok: false,
        spots: [],
        error: error?.message || 'upstream_failed',
      };
    }
  }

  async function refresh(signal) {
    const [psk, wspr] = await Promise.all([
      fetchProvider('pskreporter', PSK_URL, parsePskXml, signal),
      fetchProvider('wsprnet', WSPR_URL, parseWsprHtml, signal),
    ]);
    signal.throwIfAborted();
    if (!psk.ok && !wspr.ok) {
      throw invalid(`both_upstreams_failed: ${psk.error}; ${wspr.error}`);
    }
    const spots = [...psk.spots, ...wspr.spots]
      .sort((a, b) => b.timeMs - a.timeMs)
      .slice(0, MAX_SPOTS);
    const providers = {
      pskreporter: psk.ok ? { count: psk.count } : { error: psk.error },
      wsprnet: wspr.ok ? { count: wspr.count } : { error: wspr.error },
    };
    cache = { providers, spots, fetchedAt: now() };
    return cache;
  }

  async function acquire(signal) {
    signal.throwIfAborted();
    if (cache && now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
    if (operation?.controller.signal.aborted) operation = null;
    if (!operation) {
      if (now() - attemptedAt < RETRY_COOLDOWN_MS)
        throw new Error('invisible_ocean_retry_later');
      attemptedAt = now();
      const controller = new AbortController();
      const owned = { controller, waiters: 0 };
      const timer = setTimeout(() => controller.abort(), timeoutMs * 2 + 5000);
      owned.promise = refresh(controller.signal).finally(() => {
        clearTimeout(timer);
        if (operation === owned) operation = null;
      });
      operation = owned;
    }
    const owned = operation;
    if (owned.waiters >= 32)
      throw Object.assign(new Error('invisible_ocean_busy'), { status: 429 });
    owned.waiters++;
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([owned.promise, cancelled]);
    } finally {
      signal.removeEventListener('abort', abort);
      if (--owned.waiters === 0 && operation === owned) {
        owned.controller.abort();
        if (signal.aborted) attemptedAt = -Infinity;
      }
    }
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 429 ? { 'Retry-After': '2' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' });
      // Mounted at /api/invisible-ocean: req.url is the remainder ('/spots?...').
      const pathname = (req.url || '').split('?')[0];
      if (pathname !== '/' && pathname !== '' && pathname !== '/spots') {
        return json(400, { error: 'invalid_invisible_ocean_query' });
      }
      try {
        json(200, describe(await acquire(controller.signal)));
      } catch (error) {
        if (error.status === 429)
          return json(429, { error: 'invisible_ocean_busy' });
        const usable = cache && now() - cache.fetchedAt <= STALE_MS;
        json(
          200,
          usable
            ? describe(cache, {
                stale: true,
                reason: 'Upstream unreachable; showing last good sweep.',
              })
            : describe(null, {
                reason:
                  'Propagation feeds unreachable and no cached sweep exists.',
              }),
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'invisible-ocean',
    configureServer({ middlewares }) {
      middlewares.use('/api/invisible-ocean', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/invisible-ocean', handler);
    },
  };
}
