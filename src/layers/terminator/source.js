/**
 * Trivial time source for the terminator layer: the geometry is pure solar
 * math, so the "snapshot" is just the current instant.
 */
export function createTerminatorSource() {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      return { timeMs: Date.now() };
    },
  };
}
