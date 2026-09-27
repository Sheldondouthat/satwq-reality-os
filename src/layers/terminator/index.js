import * as Cesium from 'cesium';
import {
  subsolarPoint,
  antisolarPoint,
  terminatorRing,
} from './model.js';
export * from './model.js';
export { createTerminatorSource } from './source.js';

/** Mean Earth radius (m): night-cap ellipse semi-axis = quarter circumference. */
const NIGHT_CAP_RADIUS_M = (Math.PI / 2) * 6378137;

/** Own one day/night terminator display and its refresh lifecycle. */
export function createTerminatorLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Terminator requires a snapshot source');
  let _viewer = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _lastSub = null;

  const layer = {
    id: 'terminator',
    name: 'Day/Night Terminator',
    icon: '🌗',
    source: 'Computed (solar ephemeris)',
    updateInterval: 60000,

    init(viewer) {
      if (_viewer) throw new Error('Terminator layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('terminator');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _lastSub = null;
      console.log('[Data:Terminator] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable(viewer) {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      try {
        const { timeMs } = await source.getSnapshot();
        if (!_enabled || !_dataSource) return false;
        const date = new Date(timeMs);
        const sub = subsolarPoint(date);
        const anti = antisolarPoint(date);
        const ring = terminatorRing(date);
        const closed = ring.concat([ring[0]]);
        const positions = Cesium.Cartesian3.fromDegreesArray(
          closed.flatMap(([lon, lat]) => [lon, lat]),
        );

        _dataSource.entities.removeAll();
        _dataSource.entities.add(
          new Cesium.Entity({
            id: 'terminator:ring',
            polyline: {
              positions,
              width: 2,
              material: new Cesium.ColorMaterialProperty(
                Cesium.Color.WHITE.withAlpha(0.9),
              ),
              clampToGround: true,
            },
          }),
        );
        _dataSource.entities.add(
          new Cesium.Entity({
            id: 'terminator:night',
            position: Cesium.Cartesian3.fromDegrees(anti.lon, anti.lat),
            ellipse: {
              semiMajorAxis: NIGHT_CAP_RADIUS_M,
              semiMinorAxis: NIGHT_CAP_RADIUS_M,
              material: new Cesium.ColorMaterialProperty(
                Cesium.Color.BLACK.withAlpha(0.35),
              ),
              height: 0,
            },
          }),
        );

        _count = 2;
        _lastSub = sub;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:Terminator] Updated: subsolar ${sub.lat.toFixed(2)}°, ${sub.lon.toFixed(2)}°`,
        );
        return true;
      } catch (e) {
        console.warn('[Data:Terminator] Update error:', e);
        _lastError = e?.message || 'Terminator update failed';
        return false;
      }
    },

    destroy(viewer = _viewer) {
      _viewer = null;
      _enabled = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _lastSub = null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        subsolarLat: _lastSub?.lat ?? null,
        subsolarLon: _lastSub?.lon ?? null,
      };
    },
  };
  return layer;
}
