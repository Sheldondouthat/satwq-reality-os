/**
 * Reentry source — fetches TLE-decay candidates from /api/reentries.
 * fetchImpl injectable for tests. Nothing here renders or touches the DOM.
 */
import { coerceCandidate } from './model.js';

async function fetchJson(fetchImpl, url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function createReentrySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  base = '/api/reentries',
} = {}) {
  /**
   * @returns {Promise<{candidates: object[], count: number,
   *   fetchedAt: string|null, honesty: string|null}>} soonest TCA first.
   */
  async function getReentries({ max = 25 } = {}) {
    const url = `${base}?limit=${encodeURIComponent(max)}`;
    const payload = await fetchJson(fetchImpl, url);
    if (!payload || !Array.isArray(payload.candidates)) throw new Error('Malformed reentries proxy response');
    const candidates = [];
    for (const raw of payload.candidates) {
      const c = coerceCandidate(raw);
      if (c) candidates.push(c);
    }
    candidates.sort((a, b) => a.tcaMs - b.tcaMs);
    return {
      candidates,
      count: candidates.length,
      fetchedAt: payload.fetchedAt ?? null,
      honesty: payload.honesty ?? null,
    };
  }

  return { getReentries };
}
