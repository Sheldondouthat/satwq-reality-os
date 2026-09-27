/**
 * Argo frontier feature — data layer only (Track 2b).
 *
 * `init()` is the fail-soft mount entry point: it wires the Argo float data
 * source (server proxy /api/argo) and keeps a fresh snapshot available via
 * getSnapshot(). It never throws — on any failure it warns and returns a
 * no-op handle. The ocean-twin UX is owned by worker W10, which consumes
 * this snapshot (or /api/argo directly).
 */
import { createArgoSource } from './source.js';

export function init({ fetchImpl, proxyBase, refreshMs, onData } = {}) {
  try {
    const source = createArgoSource({
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
    console.warn('[frontier] argo init failed:', error);
    return {
      source: null,
      stop() {},
      getSnapshot: () => null,
    };
  }
}

export { createArgoSource };
