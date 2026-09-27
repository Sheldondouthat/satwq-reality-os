import { normalizeAuroraSnapshot } from './records.js';
const API_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';
/** Request and validate the latest NOAA SWPC planetary Kp reading. */
export function createAuroraSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(API_URL, { signal });
      if (!response.ok) throw new Error(`SWPC HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const row = normalizeAuroraSnapshot(payload);
      if (!row) throw new Error('Malformed SWPC Kp response');
      return row;
    },
  };
}
