import * as Cesium from 'cesium';
import {
  AURORA_OVERLAY_SOURCE_ID,
  AURORA_OVERLAY_COHORT_LIMIT,
  AURORA_OVERLAY_COLLISION_CAPACITY,
  MAGNETIC_NORTH_POLE,
  kpColor,
  ovalRingPositions,
  createAuroraOverlayEntry,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createAuroraSource } from './source.js';

/** Own one aurora-oval display and its refresh lifecycle. */
export function createAuroraLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Aurora requires a snapshot source');
  if (!overlayHost) throw new TypeError('Aurora requires an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _lastKp = null;
  let _lastTimeMs = null;

  const layer = {
    id: 'aurora',
    name: 'Aurora (Kp)',
    icon: '🌌',
    source: 'NOAA SWPC',
    updateInterval: 300000,

    init(viewer) {
      if (_viewer) throw new Error('Aurora layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('aurora');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _lastKp = null;
      _lastTimeMs = null;
      overlayHost.setVisible(AURORA_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Aurora] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(AURORA_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(AURORA_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AURORA_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const row = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const { kp, timeMs } = row;
        const color = kpColor(kp);
        const ring = ovalRingPositions(kp);
        const positions = Cesium.Cartesian3.fromDegreesArray(
          ring.flatMap(([lon, lat]) => [lon, lat]),
        );
        const polePosition = Cesium.Cartesian3.fromDegrees(
          MAGNETIC_NORTH_POLE.lon,
          MAGNETIC_NORTH_POLE.lat,
        );

        _dataSource.entities.removeAll();
        _dataSource.entities.add(
          new Cesium.Entity({
            id: 'aurora:oval',
            polyline: {
              positions,
              width: 4,
              material: new Cesium.ColorMaterialProperty(
                color.withAlpha(0.85),
              ),
              clampToGround: true,
            },
          }),
        );

        if (_enabled) {
          overlayHost.setEntries(
            AURORA_OVERLAY_SOURCE_ID,
            [
              createAuroraOverlayEntry({
                id: 'aurora:kp',
                position: polePosition,
                kp,
                accent: color.toCssColorString(),
              }),
            ],
            {
              cohortLimit: AURORA_OVERLAY_COHORT_LIMIT,
              collisionCapacity: AURORA_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _count = 1;
        _lastKp = kp;
        _lastTimeMs = timeMs;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Aurora] Updated: Kp ${kp}`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Aurora] Fetch error:', e);
        _lastError = e?.message || 'Aurora source unavailable';
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
      overlayHost.clearSource(AURORA_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AURORA_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _lastKp = null;
      _lastTimeMs = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show || _lastKp == null) return [];
      return [mapAnalystRecord({ kp: _lastKp, timeMs: _lastTimeMs }, 0)];
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        kp: _lastKp,
      };
    },
  };
  return layer;
}
