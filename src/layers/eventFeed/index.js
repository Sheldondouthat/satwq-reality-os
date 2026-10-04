/**
 * eventFeed layer entry — Reality OS F1 + F6 feed panel wiring.
 *
 * This is the ONLY file in eventFeed that imports Cesium, so model.js and
 * panel.js stay testable in plain Node. The layer mounts the DOM panel and
 * provides the default click-to-fly callback; a custom onFlyTo can override it.
 */
import * as Cesium from 'cesium';
import { createEventFeedPanel } from './panel.js';

export * from './model.js';
export { createEventFeedPanel };

/** Default fly-to: camera above the incident, North-up, brief cinematic. */
export function defaultEventFlyTo(viewer, { lat, lon, title } = {}) {
  if (!viewer?.camera || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  try {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 150_000),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-45),
        roll: 0,
      },
      duration: 1.6,
    });
    console.log(
      `[Data:EventFeed] Flying to ${title || `${lat.toFixed(2)}, ${lon.toFixed(2)}`}`,
    );
  } catch (error) {
    console.warn('[Data:EventFeed] flyTo failed:', error?.message || error);
  }
}

/** Create the event-feed layer following the repo's layer factory shape. */
export function createEventFeedLayer({
  viewer,
  container,
  onFlyTo,
  pollMs,
} = {}) {
  let _viewer = viewer || null;
  let _panel = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;

  const host =
    container || (typeof document !== 'undefined' ? document.body : null);

  const layer = {
    id: 'event-feed',
    name: 'Event Feed (F1 + F6)',
    icon: '📡',
    source: 'HMS · USGS · NHC · OpenSky (keyless)',
    updateInterval: 60_000,

    init(v) {
      if (_viewer && _viewer !== v)
        throw new Error('Event feed layer is already initialized');
      _viewer = v || _viewer;
      _panel = createEventFeedPanel({
        container: host,
        pollMs,
        onFlyTo:
          typeof onFlyTo === 'function'
            ? onFlyTo
            : (where) => defaultEventFlyTo(_viewer, where),
      });
      if (!_panel)
        throw new Error('Event feed panel could not mount (no container)');
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:EventFeed] Initialized');
    },

    enable() {
      _enabled = true;
      _panel?.el && (_panel.el.hidden = false);
    },

    disable() {
      _enabled = false;
      if (_panel?.el) _panel.el.hidden = true;
    },

    async update() {
      if (!_enabled || !_panel) return false;
      try {
        await _panel.refresh();
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch (error) {
        _lastError = error?.message || 'Event feed refresh failed';
        console.warn('[Data:EventFeed] update failed:', _lastError);
        return false;
      }
    },

    setOnFlyTo(fn) {
      _panel?.setOnFlyTo(fn);
    },

    destroy() {
      _panel?.destroy();
      _panel = null;
      _viewer = null;
      _enabled = false;
    },

    getStats() {
      return {
        lastUpdate: _lastUpdate,
        error: _lastError,
        enabled: _enabled,
        panel: _panel?.getState() ?? null,
      };
    },
  };
  return layer;
}
