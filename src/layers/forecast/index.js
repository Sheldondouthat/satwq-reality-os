/**
 * F9 forecast layers — index.
 *
 * Three companion layers to the observations layers:
 *   - fire-spread: modeled downwind spread rings from ignition proxies
 *   - forecast-cones: official NHC forecast-cone polygons
 *   - volcanic-ash: VAAC volcanic-ash advisory clouds
 *
 * Wiring (register in the layer list, mount panels) lives in INTEGRATION.md.
 * Nothing here touches existing files.
 */
import * as Cesium from 'cesium';
import {
  projectSpread,
  DEFAULT_WIND,
  SPREAD_HOURS_DEFAULT,
} from './fireSpread.js';
import {
  createConeSource,
  coneStormEntity,
  CONE_FILL,
} from './cones.js';
import {
  createVaacSource,
  ashAdvisoryEntities,
  renderAshPanel,
} from './ash.js';

export * from './fireSpread.js';
export * from './cones.js';
export * from './ash.js';

const resolveMaybe = async (value) =>
  typeof value === 'function' ? value() : value;

/** Own one fire-spread projection display, its refresh lifecycle, and step toggle. */
export function createFireSpreadLayer({
  ignitions = [],
  wind = null,
  windProvider = null,
  hours = SPREAD_HOURS_DEFAULT,
  cesium = Cesium,
} = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _activeHour = null;
  let _lastWind = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _ignitionCount = 0;
  let _ringCount = 0;
  let _lastResult = null;

  const render = (result) => {
    _dataSource.entities.removeAll();
    const active = _activeHour ?? result.rings[0]?.hour;
    _activeHour = active;
    let count = 0;
    for (const ring of result.rings) {
      const isActive = ring.hour === active;
      const positions = cesium.Cartesian3.fromDegreesArray(
        ring.polygon.flatMap(([lon, lat]) => [lon, lat]),
      );
      const fill = cesium.Color.ORANGERED.withAlpha(isActive ? 0.32 : 0.08);
      _dataSource.entities.add(
        new cesium.Entity({
          id: `fire-spread:${ring.ignitionIndex}:${ring.hour}`,
          polygon: {
            hierarchy: new cesium.PolygonHierarchy(positions),
            material: new cesium.ColorMaterialProperty(fill),
          },
          polyline: {
            positions,
            clampToGround: true,
            width: isActive ? 2 : 1,
            material: new cesium.ColorMaterialProperty(fill.withAlpha(0.9)),
          },
        }),
      );
      count += 1;
    }
    // Ignition markers (proxies — never unlabeled).
    for (const ring of result.rings.filter((r, i, a) => a.findIndex((x) => x.ignitionIndex === r.ignitionIndex) === i)) {
      const { ignition } = ring;
      _dataSource.entities.add(
        new cesium.Entity({
          id: `fire-spread:ignition:${ring.ignitionIndex}`,
          position: cesium.Cartesian3.fromDegrees(ignition.lon, ignition.lat),
          point: {
            pixelSize: 7,
            color: new cesium.ConstantProperty(cesium.Color.RED),
            outlineColor: cesium.Color.WHITE,
            outlineWidth: 1,
          },
          label: {
            text: `🔥 ${ignition.label || 'ignition proxy'} · modeled`,
            font: '12px sans-serif',
            fillColor: cesium.Color.WHITE,
            outlineColor: cesium.Color.BLACK,
            outlineWidth: 2,
            style: cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new cesium.Cartesian2(0, -16),
          },
        }),
      );
    }
    _ringCount = count;
  };

  const layer = {
    id: 'fire-spread',
    name: 'Fire Spread Projection',
    icon: '🔥',
    source: 'Modeled (HMS/WFIGS ignition proxies)',
    updateInterval: 3600_000,

    init(viewer) {
      if (_viewer) throw new Error('Fire spread layer is already initialized');
      _viewer = viewer;
      _dataSource = new cesium.CustomDataSource('fire-spread');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log('[Data:FireSpread] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    /** Time-step toggle: layer.setParams({ hour: 12 }). */
    setParams(params = {}) {
      if (typeof params.hour === 'number') {
        _activeHour = params.hour;
        if (_lastResult) render(_lastResult);
      }
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      try {
        const list = (await resolveMaybe(ignitions)) ?? [];
        const w = (await resolveMaybe(windProvider)) ?? wind ?? DEFAULT_WIND;
        const result = projectSpread({ ignitions: list, wind: w, hours });
        if (_activeHour == null && result.rings.length) {
          _activeHour = result.rings[0].hour;
        }
        _lastResult = result;
        _lastWind = result.wind;
        _ignitionCount = list.length - result.skipped;
        render(result);
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:FireSpread] Updated: ${_ignitionCount} ignitions, ${_ringCount} rings`,
        );
        return true;
      } catch (e) {
        _lastError = e?.message || 'Spread projection failed';
        console.warn('[Data:FireSpread] Update error:', e);
        return false;
      }
    },

    getRowControls() {
      const hourList = [...SPREAD_HOURS_DEFAULT];
      return {
        chips: hourList.map((hour) => ({
          id: `spread-hour-${hour}`,
          label: `+${hour}h`,
          active: _activeHour === hour,
          params: { hour },
        })),
        legend: [
          { label: `+${_activeHour ?? '—'}h active projection`, color: '#ff4500' },
          { label: 'Other time steps (dimmed)', color: '#ff450088' },
          { label: 'Ignition proxy (smoke centroid / perimeter anchor)', color: '#ff0000' },
        ],
        info:
          'MODELED projection — first-order downwind ellipses, not a physics ' +
          'simulation.\n' +
          `Wind: ${_lastWind?.label ?? DEFAULT_WIND.label}\n` +
          'Ignitions are proxies (HMS smoke centroids / WFIGS anchors), not ' +
          'mapped ignition points. Keyed upgrade: FIRMS hotspots + GRIB wind.',
      };
    },

    getStats() {
      return {
        count: _ringCount,
        lastUpdate: _lastUpdate,
        error: _lastError,
        ignitions: _ignitionCount,
        wind: _lastWind,
        activeHour: _activeHour,
      };
    },

    destroy(viewer = _viewer) {
      _enabled = false;
      _viewer = null;
      _lastResult = null;
      _lastWind = null;
      _lastUpdate = null;
      _lastError = null;
      _ignitionCount = 0;
      _ringCount = 0;
      _activeHour = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
    },
  };
  return layer;
}

/** Own one NHC forecast-cone display. */
export function createForecastConesLayer({
  source = createConeSource(),
  cesium = Cesium,
} = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _empty = false;

  const layer = {
    id: 'forecast-cones',
    name: 'Hurricane Forecast Cones',
    icon: '🌀',
    source: 'NOAA NHC / CPHC',
    updateInterval: 300_000,

    init(viewer) {
      if (_viewer) throw new Error('Forecast cones layer is already initialized');
      _viewer = viewer;
      _dataSource = new cesium.CustomDataSource('forecast-cones');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log('[Data:ForecastCones] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled) return false;
        _empty = !snapshot.unavailable && snapshot.storms.length === 0;
        _dataSource.entities.removeAll();
        for (const storm of snapshot.storms) {
          _dataSource.entities.add(coneStormEntity(storm, { cesium }));
        }
        _count = snapshot.storms.length;
        _lastUpdate = Date.now();
        _lastError = snapshot.unavailable ? snapshot.reason : null;
        console.log(`[Data:ForecastCones] Updated: ${_count} storms`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled) return false;
        _lastError = e?.message || 'Cone source unavailable';
        console.warn('[Data:ForecastCones] Fetch error:', e);
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    getRowControls() {
      return {
        chips: [],
        legend: [{ label: 'Center-track uncertainty cone', color: CONE_FILL }],
        info: _empty
          ? 'No active NHC/CPHC storms — the cone layer is empty. Coverage: Atlantic and eastern/central North Pacific.'
          : 'NHC forecast cones describe center-track uncertainty, NOT storm size or the full hazard area. One labeled entity per active storm.',
      };
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError, empty: _empty };
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      _viewer = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _empty = false;
    },
  };
  return layer;
}

/** Own one volcanic-ash advisory display + advisory list panel state. */
export function createVolcanicAshLayer({
  source = createVaacSource(),
  cesium = Cesium,
} = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _snapshot = null;
  let _lastUpdate = null;
  let _lastError = null;

  const layer = {
    id: 'volcanic-ash',
    name: 'Volcanic Ash Advisories',
    icon: '🌋',
    source: 'Tokyo VAAC (JMA)',
    updateInterval: 1800_000,

    init(viewer) {
      if (_viewer) throw new Error('Volcanic ash layer is already initialized');
      _viewer = viewer;
      _dataSource = new cesium.CustomDataSource('volcanic-ash');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log('[Data:VolcanicAsh] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled) return false;
        _snapshot = snapshot;
        _dataSource.entities.removeAll();
        for (const advisory of snapshot.advisories) {
          for (const entity of ashAdvisoryEntities(advisory, { cesium })) {
            _dataSource.entities.add(entity);
          }
        }
        _lastUpdate = Date.now();
        _lastError = snapshot.unavailable ? snapshot.reason : null;
        console.log(`[Data:VolcanicAsh] Updated: ${snapshot.advisories.length} advisories`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled) return false;
        _lastError = e?.message || 'VAAC source unavailable';
        console.warn('[Data:VolcanicAsh] Fetch error:', e);
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /** Render the advisory list panel into a container (honest degraded state included). */
    renderPanel(container) {
      renderAshPanel(container, _snapshot, { onRefresh: () => layer.update() });
    },

    getRowControls() {
      const items = (_snapshot?.advisories ?? []).map((a) => ({
        id: `vaac:${a.volcanoId}:${a.advisoryNumber}`,
        text: `${a.volcano} · ${a.country ?? ''} · ${a.advisoryNumber ?? ''} · ${a.clouds.length} cloud(s)`,
      }));
      return {
        chips: [],
        list: { ariaLabel: 'Active volcanic ash advisories', items },
        legend: [
          { label: 'Observed ash cloud', color: '#ff8c42' },
          { label: 'Forecast ash cloud', color: '#ffb26b' },
        ],
        info: _snapshot?.unavailable
          ? `VAAC feed unavailable: ${_snapshot.reason}\n` +
            'Volcanoes layer (US) still shows summit locations; no ash-cloud ' +
            'geometry is rendered. Upgrade path: wire the same-origin proxy ' +
            'api/vaac.js (see INTEGRATION.md).'
          : `Advisories from ${_snapshot?.source ?? 'Tokyo VAAC'} — observed + ` +
            'forecast ash-cloud polygons parsed from official ICAO advisory text. ' +
            'Coverage: Asia-Pacific.',
      };
    },

    getStats() {
      return {
        count: _snapshot?.advisories.length ?? 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
        empty: Boolean(_snapshot && !_snapshot.unavailable && !_snapshot.advisories.length),
        unavailable: Boolean(_snapshot?.unavailable),
      };
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      _viewer = null;
      _snapshot = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _lastUpdate = null;
      _lastError = null;
    },
  };
  return layer;
}
