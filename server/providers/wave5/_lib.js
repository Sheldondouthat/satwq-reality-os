/**
 * Wave 5 ticker-provider plumbing (shared by co2/uv/markets/carbon/certs).
 *
 * Keyless, no new dependencies, Pages-safe: global fetch only, no node:
 * imports, no WASM. Hosts are pinned with `redirect: 'follow'` — workerd
 * supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053).
 * Edge degradation stays honest via { error, detail } JSON.
 */

import { readCappedResponseText } from '../common/http.js';

/**
 * GET a pinned upstream URL with a hard timeout, redirect:'follow', and a
 * byte-capped body read. Returns the decoded text. Throws with
 * status 502 on upstream trouble, 500 otherwise.
 */
export async function fetchTextCapped({
  url,
  timeoutMs = 20_000,
  bodyCapBytes = 1 * 1024 * 1024,
  accept = '*/*',
  userAgent = 'SATWQ-Reality-OS/1.0 (keyless ticker proxy)',
  label = 'wave5',
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': userAgent, Accept: accept },
    });
    if (!res.ok)
      throw Object.assign(new Error(`${label}_upstream_${res.status}`), { status: 502 });
    const { tooLarge, text } = await readCappedResponseText(res, bodyCapBytes);
    if (tooLarge)
      throw Object.assign(new Error(`${label}_upstream_too_large`), { status: 502 });
    return text;
  } catch (err) {
    if (err?.status === 502) throw err;
    throw Object.assign(
      new Error(`${label}_fetch_failed: ${err?.message ?? err}`),
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJsonCapped(opts) {
  const text = await fetchTextCapped({ ...opts, accept: 'application/json' });
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`${opts.label ?? 'wave5'}_upstream_bad_json`), { status: 502 });
  }
}

export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function sendJson(res, status, body, cacheControl = 'public, max-age=300') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/**
 * Tiny TTL + in-flight cache: { get, clear }. `loader` is called at most
 * once per concurrent burst and its result is reused for ttlMs.
 */
export function makeCache(loader, ttlMs) {
  let cache = null; // { at, payload }
  let inflight = null;
  async function get() {
    const now = Date.now();
    if (cache && now - cache.at < ttlMs) return cache.payload;
    if (!inflight) {
      inflight = loader()
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
  function clear() {
    cache = null;
    inflight = null;
  }
  return { get, clear };
}

/**
 * Build the standard provider plugin shape used by local.js /
 * registry.mjs / the Vercel mountProvider adapter.
 */
export function buildProxy({ name, route, handler }) {
  const proxy = {
    name,
    configureServer({ middlewares }) {
      middlewares.use(route, handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use(route, handler);
    },
  };
  return proxy;
}

export const _wave5LibInternals = { fetchTextCapped, fetchJsonCapped, numOrNull, makeCache, buildProxy, sendJson };
