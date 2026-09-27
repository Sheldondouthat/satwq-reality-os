/**
 * UK grid carbon intensity proxy (keyless) — decarbonization ticker.
 *
 * Upstream: https://api.carbonintensity.org.uk/intensity (National Grid ESO,
 * open; verified live 2026-09-27; returns the current half-hour window:
 * {data:[{from,to,intensity:{forecast,actual,index}}]}).
 *
 * Routes:
 *   GET /api/carbon → {generatedAt, value, unit, from, to, forecast, actual,
 *                     index, region, source, attribution}
 *
 * value = actual when present, else forecast (flagged honestly).
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'error' pinned host, no node: imports, no WASM).
 */

import { fetchJsonCapped, makeCache, numOrNull, sendJson, buildProxy } from './_lib.js';

const UPSTREAM_URL = 'https://api.carbonintensity.org.uk/intensity';
const UPSTREAM_TIMEOUT_MS = 15_000;
const BODY_CAP_BYTES = 32 * 1024; // ~200 B response; generous cap
const CACHE_TTL_MS = 30 * 60_000; // half-hourly windows
const SOURCE = 'National Grid ESO — Carbon Intensity API';
const ATTRIBUTION = 'National Grid ESO (open data)';

export function trimCarbonPayload(upstream) {
  const row = Array.isArray(upstream?.data) ? upstream.data[0] : null;
  const intensity = row?.intensity;
  if (!row || !intensity)
    throw Object.assign(new Error('carbon_upstream_shape'), { status: 502 });
  const actual = numOrNull(intensity.actual);
  const forecast = numOrNull(intensity.forecast);
  const value = actual ?? forecast;
  if (value === null)
    throw Object.assign(new Error('carbon_no_intensity'), { status: 502 });
  return {
    generatedAt: new Date().toISOString(),
    value,
    unit: 'gCO₂/kWh',
    from: typeof row.from === 'string' ? row.from : null,
    to: typeof row.to === 'string' ? row.to : null,
    forecast,
    actual,
    valueIsForecast: actual === null,
    index: typeof intensity.index === 'string' ? intensity.index : null,
    region: 'GB',
    source: SOURCE,
    attribution: ATTRIBUTION,
    honesty:
      'Intensity is for the Great Britain grid only. value is the measured ' +
      'actual where published, else the ESO forecast (flagged in valueIsForecast).',
  };
}

const cache = makeCache(
  async () =>
    trimCarbonPayload(
      await fetchJsonCapped({
        url: UPSTREAM_URL,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        bodyCapBytes: BODY_CAP_BYTES,
        label: 'carbon',
      }),
    ),
  CACHE_TTL_MS,
);

/** Mount the carbon-intensity proxy. Mirrors the vaac/nwsAlerts provider shape. */
export function carbonProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await cache.get(), 'public, max-age=1800');
    } catch (error) {
      sendJson(
        res,
        error?.status === 502 ? 502 : 500,
        { error: 'carbon_unavailable', detail: error?.message ?? 'unknown' },
        'no-store',
      );
    }
  }
  return buildProxy({ name: 'carbon', route: '/api/carbon', handler });
}

export const _carbonInternals = {
  trimCarbonPayload,
  clearCaches: () => cache.clear(),
};
