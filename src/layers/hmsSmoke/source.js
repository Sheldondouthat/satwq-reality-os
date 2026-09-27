import { parseSmokeKml } from './records.js';

/**
 * NOAA HMS daily smoke-polygon source.
 * Fetches KML through the same-origin dev-server proxy (/api/hms-smoke)
 * because the upstream host sends no CORS headers — the browser can never
 * fetch it directly.
 */
export function createHmsSmokeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiUrl = '/api/hms-smoke',
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(apiUrl, { signal });
      if (!response.ok) {
        throw new Error(
          `HMS smoke HTTP ${response.status}${response.status === 503 ? ' (proxy reports hms_unavailable)' : ''}`,
        );
      }
      const text = await response.text();
      signal?.throwIfAborted();
      let polygons;
      try {
        polygons = parseSmokeKml(text);
      } catch (err) {
        throw new Error(`Malformed HMS smoke KML: ${err?.message || err}`);
      }
      return { fetchedAt: Date.now(), polygons };
    },
  };
}
