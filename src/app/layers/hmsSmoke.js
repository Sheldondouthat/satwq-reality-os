import { createHmsSmokeLayer } from '../../layers/hmsSmoke/index.js';
/** Wire the NOAA HMS daily smoke polygons to the application. */
export function createApplicationHmsSmoke(options) {
  return createHmsSmokeLayer({ ...options });
}
