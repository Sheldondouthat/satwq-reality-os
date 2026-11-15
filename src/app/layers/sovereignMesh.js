import { createSovereignMeshLayer } from '../../layers/sovereignMesh/index.js';
/** Wire the Sovereign Mesh (nodes) layer to the application (BM3).
 * PERSONAL class: constructed like any other layer, but its catalog
 * metadata keeps it out of share links and stored layer state. */
export function createApplicationSovereignMesh(options) {
  return createSovereignMeshLayer({ ...options });
}
