/**
 * F3 — Seismic wavefronts: USGS 4.5+ / day feed snapshot source.
 *
 * Same injectable-fetch pattern as the earthquakes layer's source
 * (read-only reference — this module is standalone). Keyless public HTTP.
 */
import { normalizeQuakeFeature } from './model.js';

const API_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';

export function createUsgsWavefrontSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(API_URL, { signal });
      if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const features = payload?.features;
      if (!Array.isArray(features)) throw new Error('Malformed USGS response');
      const rows = features.map(normalizeQuakeFeature).filter(Boolean);
      return rows;
    },
  };
}
