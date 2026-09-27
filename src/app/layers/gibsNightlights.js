import { createGibsNightlightsLayer } from '../../layers/gibsNightlights/index.js';
/** Wire the NASA GIBS Black Marble night-lights tile layer to the application. */
export function createApplicationGibsNightlights(options) {
  return createGibsNightlightsLayer({ ...options });
}
