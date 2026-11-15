import { normalizeSovereignMeshPayload } from './records.js';

/**
 * Sovereign Mesh source: the same-origin /api/sovereign-mesh-nodes
 * endpoint (BM3 §3). The provider serves the bridge's feed_records
 * verbatim where the bridge lives and answers the honest unavailable
 * envelope everywhere else; this source only fetches the endpoint
 * and validates its envelope. An unavailable envelope is a snapshot
 * (the layer reports it), not an exception.
 */
export function createSovereignMeshSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiUrl = '/api/sovereign-mesh-nodes',
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(apiUrl, { signal });
      if (!response.ok) {
        throw new Error(
          `Sovereign Mesh HTTP ${response.status}${response.status === 502 ? ' (endpoint reports sovereign_mesh_unavailable)' : ''}`,
        );
      }
      const payload = await response.json();
      signal?.throwIfAborted();
      const snapshot = normalizeSovereignMeshPayload(payload);
      if (!snapshot) throw new Error('Malformed Sovereign Mesh payload');
      return snapshot;
    },
  };
}
