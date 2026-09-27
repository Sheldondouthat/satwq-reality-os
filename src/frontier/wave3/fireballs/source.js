/**
 * Fireball source — fetches normalized CNEOS events from /api/fireballs.
 * fetchImpl injectable for tests. Nothing here renders or touches the DOM.
 */
import { coerceFireball } from './model.js';

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

export function createFireballSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  base = '/api/fireballs',
} = {}) {
  /**
   * @returns {Promise<{events: object[], count: number, fetchedAt: string,
   *   honesty: string|null}>} newest-first, coerced, invalid rows dropped.
   */
  async function getFireballs({ days = 30, minKt = 0 } = {}) {
    const url = `${base}?days=${encodeURIComponent(days)}&minKt=${encodeURIComponent(minKt)}`;
    const payload = await fetchJson(fetchImpl, url);
    if (!payload || !Array.isArray(payload.events)) throw new Error('Malformed fireballs proxy response');
    const events = [];
    for (const raw of payload.events) {
      const ev = coerceFireball(raw);
      if (ev) events.push(ev);
    }
    events.sort((a, b) => b.timeMs - a.timeMs);
    return {
      events,
      count: events.length,
      fetchedAt: payload.fetchedAt ?? null,
      honesty: payload.honesty ?? null,
    };
  }

  return { getFireballs };
}
