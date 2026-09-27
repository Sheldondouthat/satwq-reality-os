import { createTerminatorLayer } from '../../layers/terminator/index.js';
/** Wire the computed day/night terminator to the application. */
export function createApplicationTerminator(options) {
  return createTerminatorLayer({ ...options });
}
