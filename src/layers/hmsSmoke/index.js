import * as Cesium from 'cesium';
import { SMOKE_DENSITY_BY_STYLE } from './records.js';
export { parseSmokeKml, SMOKE_DENSITY_BY_STYLE } from './records.js';
export { createHmsSmokeSource } from './source.js';

/** Fill color per smoke density: [css color, alpha]. */
export const SMOKE_DENSITY_STYLE = Object.freeze({
  light: Object.freeze({ color: Cesium.Color.YELLOW, alpha: 0.25 }),
  moderate: Object.freeze({ color: Cesium.Color.ORANGE, alpha: 0.35 }),
  heavy: Object.freeze({ color: Cesium.Color.RED, alpha: 0.45 }),
});

function densityMaterial(density) {
  const style = SMOKE_DENSITY_STYLE[density] || SMOKE_DENSITY_STYLE.light;
  return style.color.withAlpha(style.alpha);
}

/** Own one NOAA HMS smoke-polygon display and its refresh lifecycle. */
export function createHmsSmokeLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('HMS smoke requires a snapshot source');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _updatedAt = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'hms-smoke',
    name: 'Wildfire Smoke',
    icon: '🌫️',
    source: 'NOAA HMS',
    updateInterval: 3600_000,

    init(viewer) {
      if (_viewer) throw new Error('HMS smoke layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('hms-smoke');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _updatedAt = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:HmsSmoke] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const { polygons } = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        _dataSource.entities.removeAll();
        let added = 0;
        for (const { density, ring } of polygons) {
          if (!Array.isArray(ring) || ring.length < 4) continue;
          _dataSource.entities.add(
            new Cesium.Entity({
              id: `hms-smoke:${added}`,
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(
                  Cesium.Cartesian3.fromDegreesArray(
                    ring.flatMap(([lon, lat]) => [lon, lat]),
                  ),
                ),
                clampToGround: true,
                material: densityMaterial(density),
              },
            }),
          );
          added += 1;
        }

        _count = added;
        _updatedAt = Date.now();
        _lastError = null;
        console.log(`[Data:HmsSmoke] Updated: ${added} smoke polygons`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:HmsSmoke] Fetch error:', e);
        _lastError = e?.message || 'HMS smoke source unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _updatedAt = null;
      _lastError = null;
    },

    getStats() {
      return {
        count: _count,
        updatedAt: _updatedAt,
        error: _lastError,
      };
    },
  };
  return layer;
}
