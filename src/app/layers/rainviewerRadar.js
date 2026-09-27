import { createRainviewerRadarLayer } from '../../layers/rainviewerRadar/index.js';
/** Wire the RainViewer radar tile layer to the application. */
export function createApplicationRainviewerRadar(options) {
  return createRainviewerRadarLayer({ ...options });
}
