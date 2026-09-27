/**
 * NMDB frontier feature — data layer only (Track 2b).
 *
 * `init()` is the fail-soft mount entry point: it wires the NMDB data
 * source (server proxy /api/nmdb) and keeps a fresh snapshot available via
 * getSnapshot(). It never throws — on any failure it warns and returns a
 * no-op handle. Cosmic-ray WEATHER UX/alerts are owned by worker W7, which
 * consumes this snapshot (or /api/nmdb directly).
 */
import { createNmdbSource } from './source.js';

export function init({ fetchImpl, proxyBase, refreshMs, onData } = {}) {
  try {
    const source = createNmdbSource({
      fetchImpl,
      proxyBase,
      refreshMs,
    });
    const stop = source.start(onData);
    return {
      source,
      stop,
      getSnapshot: () => source.getSnapshot(),
    };
  } catch (error) {
    console.warn('[frontier] nmdb init failed:', error);
    return {
      source: null,
      stop() {},
      getSnapshot: () => null,
    };
  }
}

export { createNmdbSource };
