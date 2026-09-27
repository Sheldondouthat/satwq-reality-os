import * as Cesium from 'cesium';
import {
  VOLCANO_OVERLAY_SOURCE_ID,
  VOLCANO_OVERLAY_COHORT_LIMIT,
  VOLCANO_OVERLAY_COLLISION_CAPACITY,
  colorCodeColor,
  isElevated,
  createVolcanoOverlayEntry,
  selectVolcanoOverlayCohort,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createVolcanoSource } from './source.js';

/** Own one volcano display and its refresh lifecycle. */
export function createVolcanoesLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Volcanoes require a snapshot source');
  if (!overlayHost) throw new TypeError('Volcanoes require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'volcanoes',
    name: 'Volcanoes (US)',
    icon: '⛰',
    source: 'USGS Volcano Hazards Program',
    updateInterval: 900000,

    init(viewer) {
      if (_viewer) throw new Error('Volcano layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('volcanoes');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(VOLCANO_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Volcanoes] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(VOLCANO_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(VOLCANO_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(VOLCANO_OVERLAY_SOURCE_ID, false);
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

        const nextEntities = [];
        let count = 0;
        const overlayEntries = [];

        for (const {
          stableId,
          name,
          lon,
          lat,
          alertLevel,
          colorCode,
        } of rows) {
          count++;
          const elevated = isElevated(colorCode);
          const baseRadius = elevated ? 60000 : 22000;
          const color = colorCodeColor(colorCode);
          const position = Cesium.Cartesian3.fromDegrees(lon, lat);
          nextEntities.push(
            new Cesium.Entity({
              id: `volcano:${stableId}`,
              position,
              ellipse: {
                semiMajorAxis: baseRadius,
                semiMinorAxis: baseRadius,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(elevated ? 0.55 : 0.35),
                ),
                outline: true,
                outlineColor: color.withAlpha(0.9),
                outlineWidth: elevated ? 3 : 1,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: { name, alertLevel, colorCode },
            }),
          );
          overlayEntries.push(
            createVolcanoOverlayEntry({
              id: String(stableId),
              position,
              name,
              colorCode,
              alertLevel,
              accent: color.toCssColorString(),
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        if (_enabled) {
          overlayHost.setEntries(
            VOLCANO_OVERLAY_SOURCE_ID,
            selectVolcanoOverlayCohort(overlayEntries),
            {
              cohortLimit: VOLCANO_OVERLAY_COHORT_LIMIT,
              collisionCapacity: VOLCANO_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Volcanoes] Updated: ${_count} volcanoes`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Volcanoes] Fetch error:', e);
        _lastError = e?.message || 'Volcano source unavailable';
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
      overlayHost.clearSource(VOLCANO_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(VOLCANO_OVERLAY_SOURCE_ID, false);
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
              colorCode: p?.colorCode?.getValue(now) ?? null,
              alertLevel: p?.alertLevel?.getValue(now) ?? null,
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
