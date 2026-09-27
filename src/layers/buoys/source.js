import { parseBuoyStationsXml } from './records.js';
const API_URL = 'https://www.ndbc.noaa.gov/activestations.xml';
/** Request and validate the NDBC active-station list. */
export function createBuoySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(API_URL, { signal });
      if (!response.ok) throw new Error(`NDBC HTTP ${response.status}`);
      const text = await response.text();
      signal?.throwIfAborted();
      const rows = parseBuoyStationsXml(text);
      if (!rows) throw new Error('Malformed NDBC station XML');
      return rows;
    },
  };
}
