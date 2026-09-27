/**
 * EONET frontier feature — data layer only (Track 2b).
 *
 * `init()` is the fail-soft mount entry point: it wires the EONET data
 * source (server proxy /api/eonet) and keeps a fresh snapshot available via
 * getSnapshot(). It never throws — on any failure it warns and returns a
 * no-op handle. Hazard markers + storm polylines are owned by a sibling
 * worker, which consumes this snapshot (or /api/eonet directly).
 */
import { createEonetSource } from './source.js';

export function init({ fetchImpl, proxyBase, refreshMs, onData } = {}) {
  try {
    const source = createEonetSource({
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
    console.warn('[frontier] eonet init failed:', error);
    return {
      source: null,
      stop() {},
      getSnapshot: () => null,
    };
  }
}

export { createEonetSource };
