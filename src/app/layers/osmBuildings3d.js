import { createOsmBuildings3dLayer } from '../../layers/osmBuildings3d/index.js';

/**
 * Application entrypoint for the OSM 3D Buildings layer.
 * Mirrors the other `src/app/layers/*.js` wrappers: keep Cesium-flavoured
 * application wiring here, keep the layer itself framework-agnostic.
 */
export function createApplicationOsmBuildings3d(options = {}) {
  return createOsmBuildings3dLayer({ ...options });
}
