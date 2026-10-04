/**
 * OSM 3D Buildings layer — the zero-key photoreal fallback.
 *
 * When neither a direct Google Maps key nor a Cesium ion token is configured,
 * the scene boots the plain keyless globe with no 3D at all. This layer fills
 * that gap for free: it pulls bounded building footprints through the app's
 * existing keyless `/api/overpass` proxy and extrudes them as Cesium polygon
 * entities around the current camera position. No key, no ion token, no paid
 * anything — just OpenStreetMap data (ODbL 1.0, attributed in the credit
 * popover via DATA_CREDITS).
 *
 * Refreshes on the layer lifecycle cadence; skips while the camera is too
 * high (the viewport would cover a whole metro) and replaces the previous
 * extrusion set atomically on each successful refresh.
 */
import * as Cesium from 'cesium';
import {
  OSM_BUILDINGS_LAYER_ID,
  OSM_BUILDINGS_UPDATE_INTERVAL_MS,
  buildBuildingsQuery,
  clampViewBbox,
  flattenFootprintPositions,
  halfDegForAltitude,
  parseBuildingsResponse,
  shouldFetchForAltitude,
} from './model.js';

const BUILDING_FILL =
  Cesium.Color.fromCssColorString('#8fa3b8').withAlpha(0.72);
const BUILDING_OUTLINE =
  Cesium.Color.fromCssColorString('#3d4c5e').withAlpha(0.9);
const BUILDING_MATERIAL = new Cesium.ColorMaterialProperty(BUILDING_FILL);

/**
 * Default Overpass transport: POST the QL through the app's keyless proxy,
 * mirroring the contract in `src/layers/traffic/source.js`.
 * @param {string} query
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<unknown>}
 */
export async function defaultQueryOverpass(query, { signal } = {}) {
  const response = await fetch('/api/overpass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Overpass HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Create the OSM 3D buildings layer object (application-layer contract).
 * @param {{ queryOverpass?: typeof defaultQueryOverpass }} [options]
 * @returns {object}
 */
export function createOsmBuildings3dLayer(options = {}) {
  const queryOverpass = options.queryOverpass || defaultQueryOverpass;
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _request = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _lastCenter = null;

  function guard() {
    return _viewer && _dataSource;
  }

  async function refresh() {
    const viewer = _viewer;
    const dataSource = _dataSource;
    if (!viewer || !dataSource || !_enabled) return false;
    const camera = viewer.camera;
    if (!camera || !camera.position) return false;

    let cartographic;
    try {
      cartographic = Cesium.Cartographic.fromCartesian(camera.position);
    } catch {
      return false;
    }
    if (!cartographic || !shouldFetchForAltitude(cartographic.height)) {
      return false;
    }
    const lat = Cesium.Math.toDegrees(cartographic.latitude);
    const lon = Cesium.Math.toDegrees(cartographic.longitude);
    const bbox = clampViewBbox(
      lat,
      lon,
      halfDegForAltitude(cartographic.height),
    );
    const query = buildBuildingsQuery(
      bbox.south,
      bbox.west,
      bbox.north,
      bbox.east,
    );

    if (_request) _request.abort();
    const request = new AbortController();
    _request = request;
    try {
      const json = await queryOverpass(query, { signal: request.signal });
      if (request.signal.aborted || _request !== request || !_enabled) {
        return false;
      }
      const footprints = parseBuildingsResponse(json);
      const entities = dataSource.entities;
      entities.removeAll();
      for (const footprint of footprints) {
        entities.add(
          new Cesium.Entity({
            id: footprint.id,
            polygon: {
              hierarchy: Cesium.Cartesian3.fromDegreesArray(
                flattenFootprintPositions(footprint.positions),
              ),
              extrudedHeight: footprint.height,
              material: BUILDING_MATERIAL,
              outline: true,
              outlineColor: BUILDING_OUTLINE,
            },
          }),
        );
      }
      _count = footprints.length;
      _lastUpdate = Date.now();
      _lastError = null;
      _lastCenter = { lat, lon };
      console.log(
        `[Data:OsmBuildings3d] Extruded ${_count} buildings near ${lat.toFixed(3)},${lon.toFixed(3)}`,
      );
      return true;
    } catch (e) {
      if (request.signal.aborted || _request !== request || !_enabled) {
        return false;
      }
      console.warn('[Data:OsmBuildings3d] Fetch error:', e);
      _lastError = e?.message || 'Overpass query failed';
      return false;
    } finally {
      if (_request === request) _request = null;
    }
  }

  return {
    id: OSM_BUILDINGS_LAYER_ID,
    name: 'OSM 3D Buildings',
    icon: '🏢',
    source: 'OpenStreetMap · Overpass (keyless)',
    updateInterval: OSM_BUILDINGS_UPDATE_INTERVAL_MS,

    init(viewer) {
      if (_viewer === viewer && _dataSource) return;
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(OSM_BUILDINGS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      if (!guard()) return;
      _enabled = true;
      _dataSource.show = true;
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) {
        _dataSource.show = false;
        _dataSource.entities.removeAll();
      }
      _count = 0;
      _lastError = null;
    },

    async update() {
      return refresh();
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      if (_dataSource && viewer) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _lastCenter = null;
    },

    getCount() {
      return _count;
    },

    getStatus() {
      if (!_enabled) return { state: 'disabled' };
      if (_lastError) return { state: 'error', message: _lastError };
      if (_lastUpdate) {
        return {
          state: 'ok',
          count: _count,
          center: _lastCenter,
          updatedAt: _lastUpdate,
        };
      }
      return { state: 'loading' };
    },
  };
}
