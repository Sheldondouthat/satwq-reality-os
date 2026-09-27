import { createMeteorsLayer } from '../../layers/meteors/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire bundled meteor-shower activity to the application overlay host. */
export function createApplicationMeteors(options) {
  return createMeteorsLayer({ overlayHost, ...options });
}
