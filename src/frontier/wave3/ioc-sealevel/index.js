/**
 * IOC sea-level frontier feature — data layer only (Track 2b).
 *
 * `init()` is the fail-soft mount entry point: it wires the IOC sea-level
 * data source (server proxy /api/sealevel) and keeps a fresh snapshot
 * available via getSnapshot(). It never throws — on any failure it warns
 * and returns a no-op handle. The tidal sentinel ring UX is owned by a
 * sibling worker, which consumes this snapshot (or /api/sealevel directly).
 */
import { createSealevelSource } from './source.js';

export function init({ fetchImpl, proxyBase, refreshMs, onData } = {}) {
  try {
    const source = createSealevelSource({
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
    console.warn('[frontier] sealevel init failed:', error);
    return {
      source: null,
      stop() {},
      getSnapshot: () => null,
    };
  }
}

export { createSealevelSource };
