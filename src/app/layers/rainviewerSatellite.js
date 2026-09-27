import { createRainviewerSatelliteLayer } from '../../layers/rainviewerSatellite/index.js';
/** Wire the RainViewer satellite-IR tile layer to the application. */
export function createApplicationRainviewerSatellite(options) {
  return createRainviewerSatelliteLayer({ ...options });
}
