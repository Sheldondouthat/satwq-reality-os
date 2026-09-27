import { createGibsChlorophyllLayer } from '../../layers/gibsChlorophyll/index.js';
/** Wire the NASA GIBS ocean-chlorophyll tile layer to the application. */
export function createApplicationGibsChlorophyll(options) {
  return createGibsChlorophyllLayer({ ...options });
}
