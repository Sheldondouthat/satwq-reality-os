/**
 * F5 — NOAA OVATION aurora layer.
 *
 * Paints the real OVATION aurora probability grid as a canvas texture over
 * the whole globe (Cesium.SingleTileImageryProvider), masked to the night
 * side via the shared solar ephemeris (`../terminator/model.js`, read-only).
 * Day-side cells are dimmed, not deleted, so the data extent stays visible.
 *
 * On fetch/parse failure the layer keeps its last good frame and reports
 * the error in getStats() — it never renders fake aurora.
 *
 * `createOvationLegend()` builds a small HUD legend (intensity scale +
 * observation time), styled inline so no stylesheet edits are needed.
 */
import * as Cesium from 'cesium';
import { subsolarPoint } from '../terminator/model.js';
import { createOvationSource } from './source.js';
import {
  OVATION_GRID_LONS,
  OVATION_GRID_LATS,
  ovationImageBuffer,
  ovationLegendStops,
} from './model.js';

export * from './model.js';
export { createOvationSource, OVATION_URL } from './source.js';

const UPDATE_INTERVAL_MS = 5 * 60 * 1000; // SWPC refreshes the grid every few minutes
const OVERLAY_SOURCE_ID = 'aurora-ovation';

export function createAuroraOvationLayer({ source, overlayHost } = {}) {
  const ovationSource = source || createOvationSource();
  if (typeof ovationSource.getSnapshot !== 'function')
    throw new TypeError('AuroraOvation requires a snapshot source');

  let _viewer = null;
  let _imageryLayer = null;
  let _request = null;
  let _enabled = false;
  let _canvas = null;
  let _lastGrid = null;
  let _lastUpdate = null;
  let _lastError = null;

  function detach() {
    if (_viewer && _imageryLayer) {
      try {
        _viewer.imageryLayers.remove(_imageryLayer);
      } catch {
        /* removal is best effort */
      }
    }
    _imageryLayer = null;
  }

  function attachTexture(grid) {
    if (!_canvas) {
      _canvas = document.createElement('canvas');
      _canvas.width = OVATION_GRID_LONS;
      _canvas.height = OVATION_GRID_LATS;
    }
    const sub = subsolarPoint(new Date(grid.observationTimeMs));
    const { width, height, data } = ovationImageBuffer(grid, {
      subLon: sub.lon,
      subLat: sub.lat,
    });
    const ctx = _canvas.getContext('2d');
    ctx.putImageData(new ImageData(data, width, height), 0, 0);
    const provider = new Cesium.SingleTileImageryProvider({
      url: _canvas.toDataURL('image/png'),
      rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90),
    });
    detach();
    _imageryLayer = _viewer.imageryLayers.addImageryProvider(provider);
    _imageryLayer.alpha = 0.9;
  }

  const layer = {
    id: 'aurora-ovation',
    name: 'Aurora (OVATION)',
    icon: '🌌',
    source: 'NOAA SWPC OVATION',
    updateInterval: UPDATE_INTERVAL_MS,

    init(viewer) {
      if (_viewer)
        throw new Error('AuroraOvation layer is already initialized');
      _viewer = viewer;
      _enabled = false;
      _lastGrid = null;
      _lastUpdate = null;
      _lastError = null;
      overlayHost?.setVisible?.(OVERLAY_SOURCE_ID, false);
      console.log('[Data:AuroraOvation] Initialized');
    },

    enable(viewer = _viewer) {
      _enabled = true;
      overlayHost?.setVisible?.(OVERLAY_SOURCE_ID, true);
      void layer.update(_viewer);
    },

    disable(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      detach();
      overlayHost?.clearSource?.(OVERLAY_SOURCE_ID);
      overlayHost?.setVisible?.(OVERLAY_SOURCE_ID, false);
    },

    async update(viewer = _viewer) {
      if (!_enabled || !_viewer) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const grid = await ovationSource.getSnapshot({
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        attachTexture(grid);
        _lastGrid = grid;
        _lastUpdate = Date.now();
        _lastError = null;

        if (overlayHost && typeof overlayHost.setEntries === 'function') {
          overlayHost.setEntries(
            OVERLAY_SOURCE_ID,
            [
              {
                id: 'ovation:obs',
                position: Cesium.Cartesian3.fromDegrees(0, 82),
                variant: 'label',
                title: 'OVATION aurora',
                subtitle: `obs ${new Date(grid.observationTimeMs).toISOString().slice(0, 16).replace('T', ' ')}Z`,
                accent: '#22ff66',
              },
            ],
            { cohortLimit: 2, moving: false },
          );
        }

        console.log(
          `[Data:AuroraOvation] Updated: ${grid.count} cells, obs ${new Date(grid.observationTimeMs).toISOString()}`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:AuroraOvation] Fetch error:', e);
        _lastError = e?.message || 'SWPC OVATION unavailable';
        // Keep the last good frame on screen; do not detach.
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      detach();
      overlayHost?.clearSource?.(OVERLAY_SOURCE_ID);
      overlayHost?.setVisible?.(OVERLAY_SOURCE_ID, false);
      _viewer = null;
      _canvas = null;
      _lastGrid = null;
      _lastUpdate = null;
      _lastError = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_imageryLayer || !_lastGrid) return [];
      return [
        {
          id: 'aurora-ovation-0',
          type: 'aurora-ovation',
          observationTimeMs: _lastGrid.observationTimeMs,
          forecastTimeMs: _lastGrid.forecastTimeMs,
          cells: _lastGrid.count,
        },
      ];
    },

    getStats() {
      return {
        count: _lastGrid ? 1 : 0,
        cells: _lastGrid?.count ?? 0,
        observationTimeMs: _lastGrid?.observationTimeMs ?? null,
        forecastTimeMs: _lastGrid?.forecastTimeMs ?? null,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}

const LEGEND_CSS = [
  'position:absolute;right:14px;bottom:18px;z-index:50;',
  'background:rgba(8,12,20,.82);border:1px solid rgba(120,180,255,.25);',
  'border-radius:10px;padding:8px 12px;color:#dfe9ff;',
  'font:11px/1.5 system-ui,sans-serif;backdrop-filter:blur(6px);',
  'box-shadow:0 4px 18px rgba(0,0,0,.45);user-select:none;',
].join('');

/**
 * Build the OVATION intensity legend DOM. `getStats` is a thunk returning the
 * layer's getStats() so the observation time stays fresh; call `sync()` after
 * each layer update.
 */
export function createOvationLegend(layer, { mount = document.body } = {}) {
  if (!layer || typeof layer.getStats !== 'function')
    throw new TypeError('createOvationLegend requires an OVATION layer');
  const el = document.createElement('div');
  el.className = 'ovation-legend';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'OVATION aurora intensity legend');
  el.style.cssText = LEGEND_CSS;

  const title = document.createElement('div');
  title.textContent = '🌌 OVATION aurora';
  title.style.cssText = 'font-weight:600;margin-bottom:4px;';

  const bar = document.createElement('div');
  const stops = ovationLegendStops();
  bar.style.cssText = [
    'height:10px;border-radius:5px;margin:2px 0 2px;',
    `background:linear-gradient(to right, ${stops.map((s) => s.css).join(',')});`,
  ].join('');

  const labels = document.createElement('div');
  labels.style.cssText =
    'display:flex;justify-content:space-between;color:#9fb4d8;';
  labels.innerHTML = stops.map((s) => `<span>${s.label}</span>`).join('');

  const caption = document.createElement('div');
  caption.style.cssText = 'color:#9fb4d8;margin-top:2px;';
  caption.textContent = 'intensity 0–30+ · night side';

  const obs = document.createElement('div');
  obs.style.cssText = 'color:#7c8fb0;';
  obs.textContent = 'obs —';

  el.append(title, bar, labels, caption, obs);
  mount.appendChild(el);

  function sync() {
    const stats = layer.getStats();
    obs.textContent = stats.observationTimeMs
      ? `obs ${new Date(stats.observationTimeMs).toISOString().slice(0, 16).replace('T', ' ')}Z · ${stats.cells.toLocaleString()} cells`
      : 'obs —';
  }
  sync();

  return { el, sync, destroy: () => el.remove() };
}
