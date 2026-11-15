import { createSovereignMeshCoverageLayer } from '../../layers/sovereignMeshCoverage/index.js';
/** Wire the Sovereign Mesh (coverage) layer to the application
 * (BM3 §5 follow-on). PERSONAL class: constructed like any other
 * layer, but its catalog metadata keeps it out of share links and
 * stored layer state. It consumes the same Sovereign Mesh snapshot
 * source as the nodes layer — coverage has no endpoint of its own;
 * the render is computed locally from the node set. */
export function createApplicationSovereignMeshCoverage(options) {
  return createSovereignMeshCoverageLayer({ ...options });
}
