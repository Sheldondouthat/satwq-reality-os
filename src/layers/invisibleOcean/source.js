/**
 * Invisible Ocean (F13) — data sources.
 *
 * Two fetch paths:
 *  1. Propagation spots (WSPRnet + PSK Reporter) via the server proxy at
 *     /api/invisible-ocean/spots. BOTH upstreams omit CORS headers, so the
 *     browser cannot fetch them directly; the proxy (server/providers/
 *     invisibleOceanProxy.js) fetches + normalizes server-side.
 *  2. EM weather (NOAA SWPC summary feeds) fetched DIRECTLY — SWPC sends
 *     `Access-Control-Allow-Origin: *`, verified 2026-09-26.
 *
 * fetchImpl is injectable for tests. Nothing here renders or touches the DOM.
 */
import { parseEmWeather } from './model.js';

const SWPC = {
  speed:
    'https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json',
  mag: 'https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json',
  xray: 'https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json',
  kp: 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
  sfi: 'https://services.swpc.noaa.gov/products/summary/10cm-flux.json',
};

async function fetchJson(fetchImpl, url, { signal, timeoutMs = 15000 } = {}) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Create the Invisible Ocean source.
 *
 * @param {object} opts
 * @param {Function} opts.fetchImpl - fetch-compatible function (injectable).
 * @param {string} opts.proxyBase - base path of the server proxy.
 */
export function createInvisibleOceanSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  proxyBase = '/api/invisible-ocean',
} = {}) {
  /**
   * Live propagation spots: TX->RX arcs from volunteer WSPR + PSK reporters.
   * @returns {Promise<{spots: object[], providers: object, fetchedAt: number,
   *   unavailable: boolean, reason: string|null}>}
   */
  async function getPropagationSnapshot({ signal } = {}) {
    signal?.throwIfAborted();
    const url = `${proxyBase}/spots?limit=800`;
    const payload = await fetchJson(fetchImpl, url, { signal });
    signal?.throwIfAborted();
    if (
      !payload ||
      typeof payload !== 'object' ||
      !Array.isArray(payload.spots)
    ) {
      throw new Error('Malformed invisible-ocean proxy response');
    }
    return {
      spots: payload.spots,
      providers: payload.providers ?? {},
      fetchedAt: payload.fetchedAt ?? Date.now(),
      unavailable: payload.unavailable === true,
      reason: payload.reason ?? null,
    };
  }

  /**
   * EM weather: solar wind speed, IMF Bz, Kp, X-ray flux, 10cm flux.
   * Direct keyless fetch from NOAA SWPC (CORS-open). Partial data is fine —
   * the model is null-tolerant; a total failure throws and the panel shows
   * its empty state.
   * @returns {Promise<object>} parseEmWeather() state.
   */
  async function getEmWeatherSnapshot({ signal } = {}) {
    signal?.throwIfAborted();
    const results = await Promise.allSettled(
      Object.entries(SWPC).map(async ([key, url]) => [
        key,
        await fetchJson(fetchImpl, url, { signal }),
      ]),
    );
    signal?.throwIfAborted();
    const rows = {};
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const [key, value] = result.value;
        rows[`${key}Rows`] = value;
      }
    }
    if (Object.keys(rows).length === 0) throw new Error('SWPC unreachable');
    return parseEmWeather(rows);
  }

  return { getPropagationSnapshot, getEmWeatherSnapshot };
}

export const SWPC_ENDPOINTS = SWPC;
