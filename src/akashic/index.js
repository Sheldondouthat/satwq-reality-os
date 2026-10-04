/**
 * Akashic Records — composition root.
 *
 * initAkashic() wires the whole subsystem: persistent store -> pollers for the
 * discrete-event layers -> recorder -> replay controller -> globe markers ->
 * timeline UI. Every stage fails soft: if the viewer is missing there are no
 * markers but recording still runs; if IndexedDB is missing the log is
 * memory-only; if a feed is down that poller just logs and retries later.
 *
 * Hook: called once from src/main.js after application.start() resolves.
 */
import { createAkashicStore } from './store.js';
import { createAkashicRecorder } from './recorder.js';
import { createReplayController } from './replay.js';
import { createAkashicGlobeLayer } from './globe.js';
import { mountAkashicUI } from './ui.js';
import {
  earthquakeRowsToEvents,
  volcanoRowsToEvents,
  meteorRowsToEvents,
} from './adapters.js';
import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createVolcanoSource } from '../layers/volcanoes/source.js';
import { createMeteorSource } from '../layers/meteors/source.js';

const FIVE_MINUTES = 5 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

/**
 * @param {object} options
 * @param {object} [options.viewer] Cesium viewer; markers are skipped without it.
 * @param {object} [options.overrides] Test seam: { store, recorder, replay, mountUI }.
 */
export function initAkashic({ viewer = null, overrides = {} } = {}) {
  const store = overrides.store ?? createAkashicStore();

  const pollers = [
    {
      id: 'earthquakes',
      intervalMs: FIVE_MINUTES,
      poll: async ({ signal } = {}) => {
        const source = createUsgsEarthquakeSource();
        const rows = await source.getSnapshot({ signal });
        return earthquakeRowsToEvents(rows);
      },
    },
    {
      id: 'volcanoes',
      intervalMs: TEN_MINUTES,
      poll: async ({ signal } = {}) => {
        const source = createVolcanoSource();
        const rows = await source.getSnapshot({ signal });
        return volcanoRowsToEvents(rows);
      },
    },
    {
      id: 'meteors',
      intervalMs: ONE_HOUR,
      poll: async ({ signal } = {}) => {
        const source = createMeteorSource();
        const rows = await source.getSnapshot({ signal });
        return meteorRowsToEvents(rows);
      },
    },
  ];

  const recorder =
    overrides.recorder ?? createAkashicRecorder({ store, pollers });
  const replay = overrides.replay ?? createReplayController();

  let globe = null;
  if (viewer) {
    try {
      globe = createAkashicGlobeLayer({ viewer });
    } catch (error) {
      console.warn('[Akashic] globe markers disabled:', error);
      globe = null;
    }
  } else {
    console.warn('[Akashic] no viewer — recording without globe markers');
  }

  let ui = null;
  try {
    const mount = overrides.mountUI ?? mountAkashicUI;
    ui = mount({ store, recorder, replay, globe });
  } catch (error) {
    console.warn('[Akashic] timeline UI failed to mount:', error);
    ui = null;
  }

  recorder.start();
  console.log(
    '[Akashic] records online — timeline scrubber at the bottom of the screen',
  );
  return {
    store,
    recorder,
    replay,
    globe,
    ui,
    dispose() {
      recorder.stop();
      ui?.dispose?.();
      globe?.dispose?.();
    },
  };
}
