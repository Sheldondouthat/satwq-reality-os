/**
 * INTERMAGNET frontier feature — data layer only (Track 2b).
 *
 * `init()` is the fail-soft mount entry point: it wires the INTERMAGNET
 * data source (server proxy /api/geomag) and keeps a fresh snapshot
 * available via getSnapshot(). It never throws — on any failure it warns
 * and returns a no-op handle. The magnetic-anomaly shimmer UX is owned by
 * a sibling worker, which consumes this snapshot (or /api/geomag directly).
 */
import { createGeomagSource } from './source.js';

export function init({ fetchImpl, proxyBase, refreshMs, onData } = {}) {
  try {
    const source = createGeomagSource({
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
    console.warn('[frontier] geomag init failed:', error);
    return {
      source: null,
      stop() {},
      getSnapshot: () => null,
    };
  }
}

export { createGeomagSource };
