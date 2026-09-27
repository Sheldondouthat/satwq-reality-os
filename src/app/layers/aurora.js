import { createAuroraLayer } from '../../layers/aurora/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire the NOAA SWPC Kp aurora oval to the application overlay host. */
export function createApplicationAurora(options) {
  return createAuroraLayer({ overlayHost, ...options });
}
