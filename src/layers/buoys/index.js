import * as Cesium from 'cesium';
import {
  BUOY_OVERLAY_SOURCE_ID,
  BUOY_OVERLAY_COHORT_LIMIT,
  BUOY_OVERLAY_COLLISION_CAPACITY,
  buoyColor,
  createBuoyOverlayEntry,
  selectBuoyOverlayCohort,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createBuoySource } from './source.js';

/** Own one ocean-buoy display and its refresh lifecycle. */
export function createBuoysLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Buoys require a snapshot source');
  if (!overlayHost) throw new TypeError('Buoys require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'buoys',
    name: 'Ocean Buoys',
    icon: '🛟',
    source: 'NOAA NDBC',
    updateInterval: 3600000,

    init(viewer) {
      if (_viewer) throw new Error('Buoy layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('buoys');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(BUOY_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Buoys] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(BUOY_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(BUOY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(BUOY_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const color = buoyColor();
        const nextEntities = [];
        let count = 0;
        const overlayEntries = [];

        for (const { stableId, id, name, type, lon, lat } of rows) {
          count++;
          const position = Cesium.Cartesian3.fromDegrees(lon, lat);
          nextEntities.push(
            new Cesium.Entity({
              id: `buoy:${stableId}`,
              position,
              ellipse: {
                semiMajorAxis: 9000,
                semiMinorAxis: 9000,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(0.5),
                ),
                outline: true,
                outlineColor: color.withAlpha(0.9),
                outlineWidth: 1,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: { name, type },
            }),
          );
          overlayEntries.push(
            createBuoyOverlayEntry({
              id: String(id),
              position,
              name,
              type,
              accent: color.toCssColorString(),
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        if (_enabled) {
          overlayHost.setEntries(
            BUOY_OVERLAY_SOURCE_ID,
            selectBuoyOverlayCohort(overlayEntries),
            {
              cohortLimit: BUOY_OVERLAY_COHORT_LIMIT,
              collisionCapacity: BUOY_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Buoys] Updated: ${_count} stations`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Buoys] Fetch error:', e);
        _lastError = e?.message || 'Buoy source unavailable';
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
      overlayHost.clearSource(BUOY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(BUOY_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const cartesian = entity.position
          ? entity.position.getValue(now)
          : null;
        const carto = cartesian
          ? Cesium.Cartographic.fromCartesian(cartesian)
          : null;
        const p = entity.properties;
        result.push(
          mapAnalystRecord(
            {
              id: entity.id?.split(':')[1] ?? null,
              name: p?.name?.getValue(now) ?? null,
              type: p?.type?.getValue(now) ?? null,
              lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
              lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
            },
            result.length,
          ),
        );
      }
      return result;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
