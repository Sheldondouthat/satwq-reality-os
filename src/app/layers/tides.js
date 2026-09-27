import { createTidesLayer } from '../../layers/tides/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire NOAA tide predictions to the application overlay host. */
export function createApplicationTides(options) {
  return createTidesLayer({ overlayHost, ...options });
}
