/**
 * tourDirector.js — cinematic auto-tour for SATWQ Reality OS.
 *
 * Cesium-free pure logic: the director builds a stop list from the
 * currently-enabled data layers, flies the (injected) camera through them
 * with slow 6s flights + 4s holds, and loops until stop() is called.
 *
 * Contract expected of collaborators:
 *  - viewer.camera.flyTo({destination, orientation, duration, complete, cancel})
 *      (Cesium's Camera.flyTo reads `complete`/`cancel` — see locations.js)
 *  - viewer.camera.setView({destination, orientation}) — used for spin drift
 *  - viewer.camera.cancelFlight() — called on stop()
 *  - getLayers() → Array<{ id: string, getStats?: () => object }>
 *  - isEnabled(layerId) → boolean
 *  - destinationFor(view) → camera-ready destination (default: passthrough;
 *      the app wires Cesium.Cartesian3.fromDegrees through this hook)
 *  - schedule(fn, ms)/cancelSchedule(id) — default setTimeout/clearTimeout
 *  - now() → ms epoch — inject a fake clock in tests
 *
 * Every stop view is a plain {longitude, latitude, heightM, headingDeg,
 * pitchDeg, spin?} descriptor; heading/pitch are converted to radians at
 * flyTo time.
 */

export const FLY_DURATION_S = 6;
export const HOLD_DURATION_S = 4;
export const SPIN_RATE_DEG_S = 2;
export const SPIN_TICK_MS = 1000;
export const CLOSEUP_HEIGHT_M = 2_500_000;

const DEG = Math.PI / 180;

/** Fixed regional fallback views (longitude/latitude in degrees). */
export const REGION_VIEWS = Object.freeze({
  /** Aurora: north polar oval. */
  northPolar: Object.freeze({
    longitude: -100,
    latitude: 78,
    heightM: 12_000_000,
    headingDeg: 0,
    pitchDeg: -70,
  }),
  /** Volcanoes / live eruptions: Pacific Ring of Fire. */
  ringOfFire: Object.freeze({
    longitude: 150,
    latitude: 10,
    heightM: 9_000_000,
    headingDeg: 0,
    pitchDeg: -60,
  }),
  /** FIRMS hotspots / HMS smoke: CONUS. */
  conus: Object.freeze({
    longitude: -98.5,
    latitude: 39.8,
    heightM: 7_000_000,
    headingDeg: 0,
    pitchDeg: -60,
  }),
  /** Buoys: Pacific basin. */
  pacificBasin: Object.freeze({
    longitude: -150,
    latitude: 12,
    heightM: 11_000_000,
    headingDeg: 0,
    pitchDeg: -65,
  }),
  /** Satellites: high-orbit pull-back. */
  highOrbit: Object.freeze({
    longitude: -30,
    latitude: 20,
    heightM: 26_000_000,
    headingDeg: 0,
    pitchDeg: -90,
  }),
  /** GIBS / RainViewer / weather-satellite: global slow spin. */
  globalSpin: Object.freeze({
    longitude: 0,
    latitude: 20,
    heightM: 21_000_000,
    headingDeg: 0,
    pitchDeg: -90,
    spin: true,
  }),
  /** Terminator / moon: space-side view. */
  spaceSide: Object.freeze({
    longitude: 0,
    latitude: 0,
    heightM: 24_000_000,
    headingDeg: 0,
    pitchDeg: -90,
  }),
});

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Pull the first plausible {longitude, latitude} out of a layer stats object. */
function firstCoordinate(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const pick = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const lon = [obj.longitude, obj.lon, obj.lng].find(isFiniteNumber);
    const lat = [obj.latitude, obj.lat].find(isFiniteNumber);
    if (lon === undefined || lat === undefined) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { longitude: lon, latitude: lat };
  };
  for (const key of ['center', 'latest', 'hotspot', 'location']) {
    const found = pick(stats[key]);
    if (found) return found;
  }
  const self = pick(stats);
  if (self) return self;
  for (const key of [
    'hotspots',
    'features',
    'points',
    'events',
    'latestEvents',
  ]) {
    const arr = stats[key];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const found = pick(item) || firstCoordinate(item);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Close-up view on live data when the layer exposes coordinates, else the
 * fixed regional fallback. Layers observed in this repo only expose
 * {count, lastUpdate, error} from getStats(), so the fallback is the norm —
 * but any layer that later exposes coordinates gets the close-up for free.
 */
function closeUpOr(fallback, layer, heightM = CLOSEUP_HEIGHT_M) {
  let stats = null;
  try {
    stats = typeof layer?.getStats === 'function' ? layer.getStats() : null;
  } catch {
    stats = null;
  }
  const coord = firstCoordinate(stats);
  if (!coord) return { ...fallback };
  return {
    longitude: coord.longitude,
    latitude: coord.latitude,
    heightM,
    headingDeg: 0,
    pitchDeg: -55,
  };
}

/**
 * Ordered stop map: each entry matches one layer id (or id prefix) to a
 * cinematic viewpoint. Layers without a mapping are skipped by buildStops().
 */
const STOP_MAP = Object.freeze([
  {
    id: 'aurora',
    label: 'Aurora — north polar oval',
    view: () => ({ ...REGION_VIEWS.northPolar }),
  },
  {
    id: 'volcanoes',
    label: 'Volcanoes — Pacific Ring of Fire',
    view: (l) => closeUpOr(REGION_VIEWS.ringOfFire, l),
  },
  {
    id: 'firms',
    label: 'FIRMS — live fire detections',
    view: (l) => closeUpOr(REGION_VIEWS.conus, l),
  },
  {
    id: 'hms-smoke',
    label: 'HMS smoke plumes — CONUS',
    view: () => ({ ...REGION_VIEWS.conus }),
  },
  {
    id: 'buoys',
    label: 'Ocean buoys — Pacific basin',
    view: (l) => closeUpOr(REGION_VIEWS.pacificBasin, l),
  },
  {
    id: 'satellites',
    label: 'Satellites — high-orbit pull-back',
    view: () => ({ ...REGION_VIEWS.highOrbit }),
  },
  {
    prefix: 'gibs-',
    label: 'Global imagery — slow spin',
    view: () => ({ ...REGION_VIEWS.globalSpin }),
  },
  {
    prefix: 'rainviewer-',
    label: 'Precipitation radar — slow spin',
    view: () => ({ ...REGION_VIEWS.globalSpin }),
  },
  {
    id: 'terminator',
    label: 'Day/night terminator — space-side',
    view: () => ({ ...REGION_VIEWS.spaceSide }),
  },
  {
    id: 'moon',
    label: 'Lunar view — space-side',
    view: () => ({ ...REGION_VIEWS.spaceSide }),
  },
]);

export class TourDirector {
  constructor({
    viewer,
    getLayers,
    isEnabled,
    requestRender = () => {},
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancelSchedule = (id) => clearTimeout(id),
    destinationFor = (view) => ({ ...view }),
  } = {}) {
    if (!viewer) throw new TypeError('TourDirector requires a viewer');
    if (typeof getLayers !== 'function')
      throw new TypeError('TourDirector requires getLayers()');
    if (typeof isEnabled !== 'function')
      throw new TypeError('TourDirector requires isEnabled(layerId)');
    this._viewer = viewer;
    this._getLayers = getLayers;
    this._isEnabled = isEnabled;
    this._requestRender = requestRender;
    this._now = now;
    this._schedule = schedule;
    this._cancelSchedule = cancelSchedule;
    this._destinationFor = destinationFor;
    this._running = false;
    this._stops = [];
    this._index = 0;
    this._timers = new Set();
    this._holding = null;
  }

  get running() {
    return this._running;
  }

  /** Snapshot of the current stop list (layerId, label, view). */
  get stops() {
    return this._stops.map((s) => ({ ...s, view: { ...s.view } }));
  }

  get currentStop() {
    const s = this._stops[this._index];
    return s ? { ...s, view: { ...s.view } } : null;
  }

  /** Build the stop list from currently-enabled layers; skips unmapped ids. */
  buildStops() {
    const layers = this._getLayers() || [];
    const stops = [];
    for (const entry of STOP_MAP) {
      const layer = layers.find((l) =>
        entry.id
          ? l?.id === entry.id
          : String(l?.id ?? '').startsWith(entry.prefix),
      );
      if (!layer) continue;
      let enabled = false;
      try {
        enabled = !!this._isEnabled(layer.id);
      } catch {
        enabled = false;
      }
      if (!enabled) continue;
      stops.push({
        layerId: layer.id,
        label: entry.label,
        view: entry.view(layer),
        builtAt: this._now(),
      });
    }
    return stops;
  }

  /** Start the loop. Returns false when already running or no stops. */
  start() {
    if (this._running) return false;
    const stops = this.buildStops();
    if (stops.length === 0) return false;
    this._stops = stops;
    this._index = 0;
    this._running = true;
    this._flyTo(0);
    this._requestRender('tour:start');
    return true;
  }

  /** Stop the loop and cancel any in-flight camera motion. Returns false if idle. */
  stop() {
    if (!this._running) return false;
    this._running = false;
    this._holding = null;
    for (const id of this._timers) {
      try {
        this._cancelSchedule(id);
      } catch {
        /* ignore */
      }
    }
    this._timers.clear();
    try {
      this._viewer?.camera?.cancelFlight?.();
    } catch {
      /* ignore */
    }
    this._requestRender('tour:stop');
    return true;
  }

  _later(fn, ms) {
    const id = this._schedule(() => {
      this._timers.delete(id);
      fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  _orientationOf(view) {
    return {
      heading: (view.headingDeg ?? 0) * DEG,
      pitch: (view.pitchDeg ?? -60) * DEG,
      roll: 0,
    };
  }

  _flyTo(index) {
    if (!this._running) return;
    const stop = this._stops[index];
    if (!stop) return;
    const camera = this._viewer?.camera;
    if (typeof camera?.flyTo !== 'function') return;
    camera.flyTo({
      destination: this._destinationFor(stop.view),
      orientation: this._orientationOf(stop.view),
      duration: FLY_DURATION_S,
      // NOTE: Cesium's Camera.flyTo reads `complete`/`cancel` (not
      // onComplete/onCancel) — see locations.js flyToGlobeView.
      complete: () => this._onArrived(stop),
      cancel: () => this._onFlightCancelled(),
    });
  }

  _onArrived(stop) {
    if (!this._running) return;
    this._holding = stop;
    if (stop.view.spin) this._startSpin(stop);
    this._later(() => this._advance(), HOLD_DURATION_S * 1000);
  }

  _onFlightCancelled() {
    // User grabbed the camera (or another flyTo pre-empted us). Hold the
    // current position for the usual hold, then continue the tour.
    if (!this._running) return;
    this._holding = this._stops[this._index] ?? null;
    this._later(() => this._advance(), HOLD_DURATION_S * 1000);
  }

  _startSpin(stop) {
    const step = () => {
      if (!this._running || this._holding !== stop) return;
      stop.view = {
        ...stop.view,
        longitude: stop.view.longitude + SPIN_RATE_DEG_S,
      };
      try {
        this._viewer?.camera?.setView?.({
          destination: this._destinationFor(stop.view),
          orientation: this._orientationOf(stop.view),
        });
      } catch {
        /* ignore */
      }
      this._later(step, SPIN_TICK_MS);
    };
    this._later(step, SPIN_TICK_MS);
  }

  _advance() {
    this._holding = null;
    if (!this._running) return;
    if (this._index + 1 >= this._stops.length) {
      // Lap complete: rebuild so layer toggles take effect mid-tour.
      const stops = this.buildStops();
      if (stops.length === 0) {
        this.stop();
        return;
      }
      this._stops = stops;
      this._index = 0;
    } else {
      this._index += 1;
    }
    this._flyTo(this._index);
  }
}
