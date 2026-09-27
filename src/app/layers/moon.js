import { createMoonLayer } from '../../layers/moon/index.js';
/** Wire the computed moon-phase display to the application. */
export function createApplicationMoon(options) {
  return createMoonLayer({ ...options });
}
