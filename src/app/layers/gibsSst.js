import { createGibsSstLayer } from '../../layers/gibsSst/index.js';
/** Wire the NASA GIBS sea-surface-temperature tile layer to the application. */
export function createApplicationGibsSst(options) {
  return createGibsSstLayer({ ...options });
}
