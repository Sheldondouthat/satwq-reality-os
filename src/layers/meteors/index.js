import * as Cesium from 'cesium';
import {
  METEOR_OVERLAY_SOURCE_ID,
  METEOR_OVERLAY_COHORT_LIMIT,
  METEOR_OVERLAY_COLLISION_CAPACITY,
  radiantSubpoint,
  meteorColor,
  createMeteorOverlayEntry,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createMeteorSource } from './source.js';
export { METEOR_SHOWERS, showersActiveOn } from './records.js';

/** Own one meteor-shower display and its refresh lifecycle. */
export function createMeteorsLayer({
  source,
  overlayHost,
  now = () => new Date(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Meteors require a snapshot source');
  if (!overlayHost) throw new TypeError('Meteors require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'meteors',
    name: 'Meteor Showers',
    icon: '☄️',
    source: 'IMO (bundled)',
    updateInterval: 3600000,

    init(viewer) {
      if (_viewer) throw new Error('Meteor layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('meteors');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(METEOR_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Meteors] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(METEOR_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(METEOR_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(METEOR_OVERLAY_SOURCE_ID, false);
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

        const date = now();
        const nextEntities = [];
        let count = 0;
        const overlayEntries = [];

        for (const { stableId, shower } of rows) {
          count++;
          const { lat, lon } = radiantSubpoint(shower.ra, shower.dec, date);
          const color = meteorColor(shower.zhr);
          const radius = Math.min(90000, 25000 + shower.zhr * 400);
          const position = Cesium.Cartesian3.fromDegrees(lon, lat);
          nextEntities.push(
            new Cesium.Entity({
              id: `meteor:${stableId}`,
              position,
              ellipse: {
                semiMajorAxis: radius,
                semiMinorAxis: radius,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(0.4),
                ),
                outline: true,
                outlineColor: color.withAlpha(0.9),
                outlineWidth: 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: { name: shower.name, zhr: shower.zhr },
            }),
          );
          overlayEntries.push(
            createMeteorOverlayEntry({
              id: String(stableId),
              position,
              shower,
              accent: color.toCssColorString(),
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        if (_enabled) {
          overlayHost.setEntries(METEOR_OVERLAY_SOURCE_ID, overlayEntries, {
            cohortLimit: METEOR_OVERLAY_COHORT_LIMIT,
            collisionCapacity: METEOR_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          });
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Meteors] Updated: ${_count} active showers`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Meteors] Update error:', e);
        _lastError = e?.message || 'Meteor source unavailable';
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
      overlayHost.clearSource(METEOR_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(METEOR_OVERLAY_SOURCE_ID, false);
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
      const nowT = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const cartesian = entity.position
          ? entity.position.getValue(nowT)
          : null;
        const carto = cartesian
          ? Cesium.Cartographic.fromCartesian(cartesian)
          : null;
        const p = entity.properties;
        result.push(
          mapAnalystRecord(
            {
              name: p?.name?.getValue(nowT) ?? null,
              zhr: p?.zhr?.getValue(nowT) ?? null,
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
