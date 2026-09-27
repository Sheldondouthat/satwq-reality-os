import { normalizeVolcanoSnapshot } from './records.js';
const API_URL = 'https://volcanoes.usgs.gov/vsc/api/volcanoApi/geojson';
/** Request and validate a complete USGS volcano snapshot before it can replace displayed volcanoes. */
export function createVolcanoSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(API_URL, { signal });
      if (!response.ok)
        throw new Error(`USGS volcano API HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeVolcanoSnapshot(payload);
      if (!rows) throw new Error('Malformed USGS volcano response');
      return rows;
    },
  };
}
