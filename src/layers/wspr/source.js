import { normalizeWsprPayload } from './records.js';

/**
 * WSPR live-spot source: the same-origin /api/wspr-live endpoint
 * (BM4). The provider owns the upstream poll discipline (≥3-minute
 * cache against wspr.live's ~20 req/min ceiling); this source only
 * fetches the endpoint and validates its envelope.
 */
export function createWsprSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiUrl = '/api/wspr-live',
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(apiUrl, { signal });
      if (!response.ok) {
        throw new Error(
          `WSPR HTTP ${response.status}${response.status === 502 ? ' (endpoint reports wspr_unavailable)' : ''}`,
        );
      }
      const payload = await response.json();
      signal?.throwIfAborted();
      const snapshot = normalizeWsprPayload(payload);
      if (!snapshot) throw new Error('Malformed WSPR payload');
      return snapshot;
    },
  };
}
