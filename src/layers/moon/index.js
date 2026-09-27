import * as Cesium from 'cesium';
import { moonPosition, moonPhase } from './model.js';
export * from './model.js';

/** Own one moon-phase display and its refresh lifecycle. */
export function createMoonLayer() {
  let _viewer = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _lastPhase = null;
  let _lastPosition = null;

  const layer = {
    id: 'moon',
    name: 'Moon Phase',
    icon: '🌙',
    source: 'Computed (lunar ephemeris)',
    updateInterval: 600000,

    init(viewer) {
      if (_viewer) throw new Error('Moon layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('moon');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _lastPhase = null;
      _lastPosition = null;
      console.log('[Data:Moon] Initialized');
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
        const now = new Date();
        const position = moonPosition(now);
        const phase = moonPhase(now);
        const cartesian = Cesium.Cartesian3.fromDegrees(
          position.lon,
          position.lat,
        );

        _dataSource.entities.removeAll();
        _dataSource.entities.add(
          new Cesium.Entity({
            id: 'moon:position',
            position: cartesian,
            point: {
              pixelSize: 14,
              color: Cesium.Color.WHITESMOKE,
              outlineColor: Cesium.Color.DARKGRAY,
              outlineWidth: 1,
            },
            label: {
              text: `🌙 ${phase.name} ${Math.round(phase.illumination * 100)}%`,
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
        _lastPhase = phase;
        _lastPosition = position;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:Moon] Updated: ${phase.name} ${Math.round(phase.illumination * 100)}%`,
        );
        return true;
      } catch (e) {
        console.warn('[Data:Moon] Update error:', e);
        _lastError = e?.message || 'Moon update failed';
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
      _lastPhase = null;
      _lastPosition = null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        phaseName: _lastPhase?.name ?? null,
        illumination: _lastPhase?.illumination ?? null,
        waxing: _lastPhase?.waxing ?? null,
        subLunarLat: _lastPosition?.lat ?? null,
        subLunarLon: _lastPosition?.lon ?? null,
      };
    },
  };
  return layer;
}
