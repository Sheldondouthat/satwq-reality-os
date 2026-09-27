/**
 * Wave 3 Track 2c — shared keyless polling-proxy helper.
 *
 * Every wave3 provider is a thin, keyless, bounded poll of a public upstream:
 * fetch on a cadence, cap the bytes, cache with stale-fallback, serve one
 * bounded JSON document. This module implements that loop once; each provider
 * only supplies { route, fetchUpstream, describe }.
 *
 * Constraints honored:
 *  - keyless only; no credentials, no cookies, no device access.
 *  - plain global fetch + JSON: NO node:* imports anywhere in this file or
 *    anything it imports, so it loads in the Pages Functions (workerd)
 *    bundle via server/pages/registry.mjs.
 *  - singleflight per cache key + bounded waiter count: concurrent client
 *    requests coalesce into one upstream fetch; upstreams that rate-limit
 *    (RIPEstat: 8 req/IP concurrent) are never hammered.
 *  - fail-soft: upstream down -> serve last-good (stale) -> honest
 *    { unavailable: true, reason } JSON, never a throw to the client.
 */
import { readResponseTextCapped } from '../../common/http.js';

export const TEXT_CAP_DEFAULT = 4 * 1024 * 1024; // 4 MB per upstream document
const MAX_WAITERS = 32;
const RETRY_COOLDOWN_MS = 60_000;

/** Run fn over items with at most `limit` in flight. Order of results preserved. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Fetch a URL with timeout + UA, returning capped text. Throws on non-2xx.
 * Exported so providers can share the exact upstream fetch discipline.
 */
export async function fetchUpstreamText(
  fetchImpl,
  url,
  { signal, timeoutMs = 15_000, textCap = TEXT_CAP_DEFAULT, userAgent, accept } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        ...(userAgent ? { 'User-Agent': userAgent } : {}),
        ...(accept ? { Accept: accept } : {}),
      },
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      throw new Error(`upstream_http_${response.status}`);
    }
    const text = await readResponseTextCapped(response, textCap, controller.signal);
    signal?.throwIfAborted();
    return text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Build a keyless polling proxy plugin.
 *
 * fetchUpstream({ fetchImpl, signal, now, query }) -> payload (any JSON-safe).
 * describe(payload | null, { stale, reason }) -> response JSON document.
 * cacheKey(query: URLSearchParams) -> string (default 'default').
 */
export function createKeylessProxy({
  name,
  route,
  ttlMs,
  staleMs,
  timeoutMs = 15_000,
  fetchUpstream,
  describe,
  cacheKey = () => 'default',
  maxCacheKeys = 8,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  if (!name || !route || !fetchUpstream || !describe) {
    throw new TypeError('createKeylessProxy requires name, route, fetchUpstream, describe');
  }
  const caches = new Map(); // key -> { payload, fetchedAt }
  const operations = new Map(); // key -> { promise, controller, waiters, attemptedAt }
  // Separate per-key failure timestamps: the in-flight op object is deleted
  // after it settles, so a cooldown tied to `op` alone would be ineffective
  // against immediate retry-after-failure (the intended thundering-herd
  // guard). Success clears the failure stamp.
  const failedAt = new Map(); // key -> timestamp of last failed refresh

  async function refresh(key, query, signal) {
    try {
      const payload = await fetchUpstream({ fetchImpl, signal, now, query });
      signal.throwIfAborted();
      const entry = { payload, fetchedAt: now() };
      caches.set(key, entry);
      while (caches.size > maxCacheKeys) {
        const oldest = caches.keys().next().value;
        caches.delete(oldest);
      }
      failedAt.delete(key);
      return entry;
    } catch (error) {
      failedAt.set(key, now());
      throw error;
    }
  }

  async function acquire(key, query, signal) {
    signal.throwIfAborted();
    const cached = caches.get(key);
    if (cached && now() - cached.fetchedAt < ttlMs) return cached;
    let op = operations.get(key);
    if (!op || op.controller.signal.aborted) {
      if (op && now() - op.attemptedAt < RETRY_COOLDOWN_MS) {
        throw Object.assign(new Error(`${name}_retry_later`), { status: 503 });
      }
      if (!op) {
        const lastFailure = failedAt.get(key);
        if (lastFailure != null && now() - lastFailure < RETRY_COOLDOWN_MS) {
          throw Object.assign(new Error(`${name}_retry_later`), { status: 503 });
        }
      }
      const controller = new AbortController();
      op = { controller, waiters: 0, attemptedAt: now(), promise: null };
      const timer = setTimeout(() => controller.abort(), timeoutMs * 2 + 5000);
      op.promise = refresh(key, query, controller.signal).finally(() => {
        clearTimeout(timer);
        if (operations.get(key) === op) operations.delete(key);
      });
      operations.set(key, op);
    }
    if (op.waiters >= MAX_WAITERS) {
      throw Object.assign(new Error(`${name}_busy`), { status: 429 });
    }
    op.waiters++;
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([op.promise, cancelled]);
    } finally {
      signal.removeEventListener('abort', onAbort);
      op.waiters--;
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
      if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
      const [path, qs] = String(req.url || '').split('?');
      if (path !== '/' && path !== '') return json(400, { error: `invalid_${name}_query` });
      const query = new URLSearchParams(qs || '');
      const key = cacheKey(query);
      try {
        const entry = await acquire(key, query, controller.signal);
        json(200, describe(entry.payload, { stale: false, reason: null }));
      } catch (error) {
        if (error?.status === 429) return json(429, { error: `${name}_busy` });
        if (error?.status === 503) return json(503, describe(null, { stale: false, reason: 'retry_later' }));
        const entry = caches.get(key);
        const usable = entry && now() - entry.fetchedAt <= staleMs;
        json(
          200,
          usable
            ? describe(entry.payload, { stale: true, reason: 'Upstream unreachable; showing last good sweep.' })
            : describe(null, { reason: 'Upstream unreachable and no cached sweep exists.' }),
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name,
    configureServer({ middlewares }) {
      middlewares.use(route, handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use(route, handler);
    },
  };
}
