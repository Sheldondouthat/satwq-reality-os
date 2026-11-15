import { createWsprLayer } from '../../layers/wspr/index.js';
/** Wire WSPR propagation arcs to the application. */
export function createApplicationWspr(options) {
  return createWsprLayer({ ...options });
}
