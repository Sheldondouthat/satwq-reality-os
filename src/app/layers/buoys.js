import { createBuoysLayer } from '../../layers/buoys/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire NOAA NDBC ocean buoys to the application overlay host. */
export function createApplicationBuoys(options) {
  return createBuoysLayer({ overlayHost, ...options });
}
