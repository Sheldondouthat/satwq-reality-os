/**
 * Akashic Records — replay controller.
 *
 * Owns the live/replay mode state machine and the playhead. The controller
 * never touches the globe or DOM itself: it notifies subscribers of cutoff
 * changes and they render. Timer functions are injectable for tests.
 *
 * Modes:
 *  - 'live': cutoff tracks "now"; globe shows the full recorded log.
 *  - 'replay': cutoff is frozen (or advancing while playing); globe shows
 *    only events at/before the cutoff — the time machine.
 */
export function createReplayController({
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  tickMs = 100,
} = {}) {
  let mode = 'live';
  let cutoff = now();
  let playing = false;
  let timer = null;
  let playSpeed = 3600000; // 1 playhead-hour per real second, default
  let playEnd = Infinity;
  const listeners = new Set();

  function notify() {
    const snapshot = { mode, cutoff, playing };
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('[Akashic] replay subscriber threw', error);
      }
    }
  }

  function stopTimer() {
    if (timer != null) clearIntervalImpl(timer);
    timer = null;
    playing = false;
  }

  return {
    get mode() {
      return mode;
    },
    get cutoff() {
      return cutoff;
    },
    get playing() {
      return playing;
    },

    /** Scrub to a moment: enters replay mode with a frozen playhead. */
    setCutoff(ms) {
      if (!Number.isFinite(ms)) return;
      stopTimer();
      mode = 'replay';
      cutoff = ms;
      notify();
    },

    /** Return to live: cutoff tracks now again. */
    exitToLive() {
      stopTimer();
      mode = 'live';
      cutoff = now();
      notify();
    },

    /**
     * Animate the playhead from `fromMs` to `toMs`.
     * @param {number} msPerSecond How many event-milliseconds pass per real second.
     */
    play({ fromMs, toMs = now(), msPerSecond = playSpeed } = {}) {
      stopTimer();
      mode = 'replay';
      cutoff = Number.isFinite(fromMs) ? fromMs : now() - 86400000;
      playEnd = Number.isFinite(toMs) ? toMs : now();
      playSpeed = Number.isFinite(msPerSecond) && msPerSecond > 0 ? msPerSecond : 3600000;
      playing = true;
      notify();
      const stepMs = (playSpeed * tickMs) / 1000;
      timer = setIntervalImpl(() => {
        cutoff += stepMs;
        if (cutoff >= playEnd) {
          cutoff = playEnd;
          stopTimer();
          mode = 'live';
          cutoff = now();
        }
        notify();
      }, tickMs);
    },

    pause() {
      const wasPlaying = playing;
      stopTimer();
      if (wasPlaying) notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
