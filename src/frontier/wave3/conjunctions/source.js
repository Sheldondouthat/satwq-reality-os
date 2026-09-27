/**
 * Conjunction source — fetches normalized SOCRATES events from /api/conjunctions.
 * fetchImpl injectable for tests. Nothing here renders or touches the DOM.
 */
import { coerceConjunction } from './model.js';

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

export function createConjunctionSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  base = '/api/conjunctions',
} = {}) {
  /**
   * @returns {Promise<{events: object[], topByProbability: string[],
   *   count: number, fetchedAt: string|null, honesty: string|null}>}
   */
  async function getConjunctions({ max = 40 } = {}) {
    const url = `${base}?max=${encodeURIComponent(max)}`;
    const payload = await fetchJson(fetchImpl, url);
    if (!payload || !Array.isArray(payload.events)) throw new Error('Malformed conjunctions proxy response');
    const events = [];
    for (const raw of payload.events) {
      const ev = coerceConjunction(raw);
      if (ev) events.push(ev);
    }
    return {
      events,
      topByProbability: Array.isArray(payload.topByProbability) ? payload.topByProbability : [],
      count: events.length,
      fetchedAt: payload.fetchedAt ?? null,
      honesty: payload.honesty ?? null,
    };
  }

  return { getConjunctions };
}
