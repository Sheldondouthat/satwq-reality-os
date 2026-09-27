import * as Cesium from 'cesium';
import {
  TIDE_OVERLAY_SOURCE_ID,
  TIDE_OVERLAY_COHORT_LIMIT,
  TIDE_OVERLAY_COLLISION_CAPACITY,
  trendColor,
  createTideOverlayEntry,
  mapAnalystRecord,
  tideTrend,
} from './model.js';
export * from './model.js';
export { createTideSource, TIDE_STATIONS } from './source.js';

/** Own one tide-station display and its refresh lifecycle. */
export function createTidesLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Tides require a snapshot source');
  if (!overlayHost) throw new TypeError('Tides require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'tides',
    name: 'Tides (US Ports)',
    icon: '🌊',
    source: 'NOAA CO-OPS',
    updateInterval: 1800000,

    init(viewer) {
      if (_viewer) throw new Error('Tide layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('tides');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(TIDE_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Tides] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(TIDE_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(TIDE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(TIDE_OVERLAY_SOURCE_ID, false);
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

        const nowMs = Date.now();
        const nextEntities = [];
        let count = 0;
        const overlayEntries = [];

        for (const { stableId, name, lon, lat, events } of rows) {
          count++;
          const trend = tideTrend(events, nowMs);
          const color = trendColor(trend);
          const position = Cesium.Cartesian3.fromDegrees(lon, lat);
          nextEntities.push(
            new Cesium.Entity({
              id: `tide:${stableId}`,
              position,
              ellipse: {
                semiMajorAxis: 18000,
                semiMinorAxis: 18000,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(0.45),
                ),
                outline: true,
                outlineColor: color.withAlpha(0.9),
                outlineWidth: 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: { name, trend },
            }),
          );
          overlayEntries.push(
            createTideOverlayEntry({
              id: String(stableId),
              position,
              name,
              events,
              nowMs,
              accent: color.toCssColorString(),
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        if (_enabled) {
          overlayHost.setEntries(TIDE_OVERLAY_SOURCE_ID, overlayEntries, {
            cohortLimit: TIDE_OVERLAY_COHORT_LIMIT,
            collisionCapacity: TIDE_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          });
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Tides] Updated: ${_count} stations`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Tides] Fetch error:', e);
        _lastError = e?.message || 'Tide source unavailable';
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
      overlayHost.clearSource(TIDE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(TIDE_OVERLAY_SOURCE_ID, false);
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
              name: p?.name?.getValue(now) ?? null,
              trend: p?.trend?.getValue(now) ?? null,
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
