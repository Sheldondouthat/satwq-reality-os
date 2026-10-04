/**
 * Akashic cinematic replay (Wave 3, Track 1c, item 1.11).
 *
 * One-click replay of an archived day: steps the day's event log in
 * chronological order, composing three existing subsystems —
 *   - GIBS time-scrub via the planetary DVR layer (`dvr.goTo(timeMs)`),
 *   - the camera (`viewer` flyTo),
 *   - the sonification bus (`sonify.quakeSound(...)` style calls).
 *
 * All three are injected; the replay is pure orchestration and is tested
 * with stubs. Cancel at any time with stop(). Events with no globe position
 * are narrated through onStep but skipped on the camera.
 */

const STEP_GAP_MS = 1400; // wall-clock gap between steps at speed 1

function eventSoundKind(event) {
  if (event.type === 'quake') return 'quake';
  if (event.type === 'storm' || event.type === 'cyclone') return 'storm';
  if (event.type === 'fire') return 'fire';
  return 'ping';
}

/**
 * @param {object} deps
 * @param {object} [deps.viewer] Cesium viewer (optional)
 * @param {object} [deps.sonify] sonification handle with fns like quakeSound({magnitude})
 * @param {object} [deps.dvr] DVR layer with goTo(timeMs)
 * @param {number} [deps.cameraHeightM] flyTo height
 */
export function createReplay({
  viewer = null,
  sonify = null,
  dvr = null,
  cameraHeightM = 4000000,
} = {}) {
  let timer = null;
  let stopped = false;
  let current = null; // { day, resolveDone, played } — settleable by stop()

  const finish = (day, played, wasStopped) => {
    const c = current;
    current = null;
    timer = null;
    c?.resolveDone({ day, played, stopped: wasStopped });
  };

  async function flyTo(event) {
    if (!viewer?.camera?.flyTo) return;
    try {
      const { Cartesian3, Math: CMath } = await import('cesium');
      await new Promise((resolve) => {
        viewer.camera.flyTo({
          destination: Cartesian3.fromDegrees(
            event.lon,
            event.lat,
            cameraHeightM,
          ),
          orientation: { heading: 0, pitch: CMath.toRadians(-55), roll: 0 },
          duration: 2.2,
          complete: resolve,
          cancel: resolve,
        });
      });
    } catch {}
  }

  function soundFor(event) {
    if (!sonify) return;
    try {
      const kind = eventSoundKind(event);
      if (kind === 'quake' && typeof sonify.quakeSound === 'function') {
        sonify.quakeSound({ magnitude: event.mag ?? 5 });
      } else if (typeof sonify.eventPing === 'function') {
        sonify.eventPing({ kind, magnitude: event.mag ?? 0 });
      }
    } catch {}
  }

  function scrubTo(event) {
    if (!dvr || typeof dvr.goTo !== 'function') return;
    try {
      dvr.goTo(event.t);
    } catch {}
  }

  /**
   * Play a day's events as cinema. Returns a controller {done, stop}.
   * onStep(event, index, total) fires before each step renders.
   */
  function playDay({ day, events = [], speed = 1, onStep = null } = {}) {
    stop();
    stopped = false;
    const ordered = [...events].sort((a, b) => a.t - b.t);
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    let index = 0;
    // stop() must be able to settle a play that never started stepping.
    current = {
      day,
      resolveDone,
      get played() {
        return index;
      },
    };

    async function step() {
      if (stopped || index >= ordered.length) {
        finish(day, index, stopped);
        return;
      }
      const event = ordered[index];
      try {
        onStep?.(event, index, ordered.length);
      } catch {}
      scrubTo(event);
      await flyTo(event);
      soundFor(event);
      index++;
      if (!stopped && index < ordered.length) {
        timer = setTimeout(
          step,
          Math.max(120, STEP_GAP_MS / Math.max(0.25, speed)),
        );
      } else {
        finish(day, index, stopped);
      }
    }

    // Kick off on the next tick so playDay returns synchronously.
    timer = setTimeout(step, 0);
    return { done, stop };
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (current) finish(current.day, current.played, true);
  }

  return { playDay, stop, eventSoundKind };
}
