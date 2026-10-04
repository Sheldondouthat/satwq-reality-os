import { normalizeSpaceWeatherSnapshot } from './records.js';

const SWEPAM_URL =
  'https://services.swpc.noaa.gov/json/ace/swepam/ace_swepam_1h.json';
const MAG_URL = 'https://services.swpc.noaa.gov/json/ace/mag/ace_mag_1h.json';

/** Request and validate the latest NOAA SWPC ACE solar-wind reading. */
export function createSpaceWeatherSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function getJson(url, signal) {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`SWPC HTTP ${response.status} (${url})`);
    return response.json();
  }
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const [swepam, mag] = await Promise.all([
        getJson(SWEPAM_URL, signal),
        getJson(MAG_URL, signal),
      ]);
      signal?.throwIfAborted();
      const row = normalizeSpaceWeatherSnapshot(swepam, mag);
      if (!row) throw new Error('Malformed SWPC solar-wind response');
      return row;
    },
  };
}
