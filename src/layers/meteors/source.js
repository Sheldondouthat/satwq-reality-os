import { showersActiveOn } from './records.js';
/**
 * Fully offline source: meteor-shower activity is computed from the bundled
 * IMO table and the current date. The snapshot always validates — there is
 * no upstream to fail.
 */
export function createMeteorSource({ now = () => new Date() } = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const date = now();
      const active = showersActiveOn(date);
      return active.map((shower) => ({
        stableId: shower.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        shower,
      }));
    },
  };
}
