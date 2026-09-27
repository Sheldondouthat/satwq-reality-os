import { createGibsTruecolorLayer } from '../../layers/gibsTruecolor/index.js';
/** Wire the NASA GIBS true-color tile layer to the application. */
export function createApplicationGibsTruecolor(options) {
  return createGibsTruecolorLayer({ ...options });
}
