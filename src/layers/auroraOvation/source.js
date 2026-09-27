/**
 * F5 — NOAA OVATION aurora: SWPC snapshot source.
 *
 * Keyless public HTTPS, CORS `*` (verified 2026-09-27). Throws on malformed
 * payloads — the layer keeps its last good frame instead of faking data.
 */
import { parseOvationGrid } from './model.js';

export const OVATION_URL =
  'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';

export function createOvationSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = OVATION_URL,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, { signal });
      if (!response.ok) throw new Error(`SWPC OVATION HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const grid = parseOvationGrid(payload); // throws when malformed
      return grid;
    },
  };
}
