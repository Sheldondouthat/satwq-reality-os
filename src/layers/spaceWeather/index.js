import * as Cesium from 'cesium';
import { subsolarPoint } from '../terminator/model.js';
import { solarWindColor, solarWindLabel, mapAnalystRecord } from './model.js';
export * from './model.js';
export { createSpaceWeatherSource } from './source.js';

/** Own one solar-wind display and its refresh lifecycle. */
export function createSpaceWeatherLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Space weather requires a snapshot source');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _lastRow = null;

  const layer = {
    id: 'space-weather',
    name: 'Solar Wind',
    icon: '☀️',
    source: 'NOAA SWPC',
    updateInterval: 300000,

    init(viewer) {
      if (_viewer) throw new Error('Space weather layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('space-weather');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _lastRow = null;
      console.log('[Data:SpaceWeather] Initialized');
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
        const row = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const sub = subsolarPoint(new Date());
        const position = Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat);
        _dataSource.entities.removeAll();
        _dataSource.entities.add(
          new Cesium.Entity({
            id: 'space-weather:subsolar',
            position,
            point: {
              pixelSize: 12,
              color: solarWindColor(row.speedKms),
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: 1,
            },
            label: {
              text: solarWindLabel(row),
              font: '13px sans-serif',
              fillColor: Cesium.Color.WHITE,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -26),
            },
          }),
        );

        _count = 1;
        _lastRow = row;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:SpaceWeather] Updated: ${Math.round(row.speedKms)} km/s, Bz ${row.bzGsm.toFixed(1)} nT`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:SpaceWeather] Fetch error:', e);
        _lastError = e?.message || 'Space weather source unavailable';
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
      _lastUpdate = null;
      _lastError = null;
      _lastRow = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show || _lastRow == null) return [];
      return [mapAnalystRecord(_lastRow, 0)];
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        speedKms: _lastRow?.speedKms ?? null,
        densityPerCm3: _lastRow?.densityPerCm3 ?? null,
        tempK: _lastRow?.tempK ?? null,
        bzGsm: _lastRow?.bzGsm ?? null,
        timeMs: _lastRow?.timeMs ?? null,
      };
    },
  };
  return layer;
}
