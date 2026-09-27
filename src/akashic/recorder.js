/**
 * Akashic Records — event recorder.
 *
 * The central bus: each poller fetches one layer's source snapshot on its own
 * cadence, maps rows to Akashic events through an adapter, and hands them to
 * the store (which dedups by id). Subscribers hear about every newly recorded
 * event — the timeline histogram and globe layer both listen.
 *
 * A poller is { id, intervalMs, poll(signal) -> Promise<event[]> }.
 * No DOM, no Cesium. Fetching happens through the injected poll functions.
 */
export function createAkashicRecorder({
  store,
  pollers = [],
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (!store || typeof store.recordEvents !== 'function')
    throw new TypeError('Recorder requires a store with recordEvents()');
  const listeners = new Set();
  const timers = new Map();
  let running = false;
  let lastPollAt = {};
  let lastError = {};

  function emit(addedCount) {
    for (const listener of listeners) {
      try {
        listener(addedCount);
      } catch (error) {
        console.warn('[Akashic] subscriber threw', error);
      }
    }
  }

  async function pollOnce(poller, { signal } = {}) {
    let raw;
    try {
      raw = await poller.poll({ signal, now });
    } catch (error) {
      lastError[poller.id] = String(error?.message ?? error);
      console.warn(`[Akashic] poller "${poller.id}" failed:`, error);
      return 0;
    }
    const events = Array.isArray(raw) ? raw : [];
    let added = 0;
    try {
      added = await store.recordEvents(events);
    } catch (error) {
      lastError[poller.id] = String(error?.message ?? error);
      console.warn(`[Akashic] store write failed for "${poller.id}":`, error);
      return 0;
    }
    delete lastError[poller.id];
    lastPollAt[poller.id] = now();
    if (added > 0) {
      // Nudge subscribers; they re-read the store themselves, so the exact
      // payload does not need to be the precise new-event set.
      emit(added);
    }
    return added;
  }

  function start() {
    if (running) return;
    running = true;
    for (const poller of pollers) {
      const intervalMs = Math.max(15000, Number(poller.intervalMs) || 300000);
      // Poll immediately on start so the timeline seeds fast, then on cadence.
      pollOnce(poller).catch(() => {});
      timers.set(
        poller.id,
        setIntervalImpl(() => pollOnce(poller).catch(() => {}), intervalMs),
      );
    }
  }

  function stop() {
    running = false;
    for (const timer of timers.values()) clearIntervalImpl(timer);
    timers.clear();
  }

  return {
    get running() {
      return running;
    },
    get lastPollAt() {
      return { ...lastPollAt };
    },
    get lastError() {
      return { ...lastError };
    },
    start,
    stop,
    pollOnce,
    pollAllOnce(options) {
      return Promise.all(pollers.map((poller) => pollOnce(poller, options)));
    },
    onEvents(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
