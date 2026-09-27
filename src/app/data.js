import { LayerLifecycle } from '../data/lifecycle.js';
import { LayerPresentation } from './layerPresentation.js';
import { createCyberSonarScene } from '../cyberSonarScene.js';
import { LAYER_STATE_STORAGE_KEY } from '../data/layerState.js';
import { OSM_BUILDINGS_LAYER_ID } from '../layers/osmBuildings3d/model.js';

/**
 * Auto-enable the zero-key OSM 3D-buildings fallback on a fresh keyless
 * session: no photoreal tileset (neither a direct Google key nor an ion
 * token produced one), no share payload in the URL hash, and no stored
 * layer preferences from a previous visit. Explicit user intent — a stored
 * state or a share link — always wins over this default.
 */
function maybeAutoEnableKeylessBuildings({ dataManager, tileset }) {
  try {
    if (tileset) return;
    if (
      typeof window !== 'undefined' &&
      window.location &&
      window.location.hash &&
      window.location.hash.length > 1
    ) {
      return;
    }
    let stored = null;
    try {
      stored =
        typeof window !== 'undefined' &&
        window.localStorage?.getItem(LAYER_STATE_STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (stored) return;
    if (!dataManager?.layers?.has(OSM_BUILDINGS_LAYER_ID)) return;
    void dataManager
      .setEnabled(OSM_BUILDINGS_LAYER_ID, true, { origin: 'programmatic' })
      .catch((error) => {
        console.warn(
          '[Data:OsmBuildings3d] Auto-enable failed:',
          error?.message || error,
        );
      });
  } catch (error) {
    console.warn(
      '[Data:OsmBuildings3d] Auto-enable check failed:',
      error?.message || error,
    );
  }
}
/** Register the application layer catalog before allowing state restoration. */
export function createApplicationData({
  scene: { viewer, mapStackController, tileset },
  controls: { styleManager },
  catalog,
  allowQaRegistration,
  onData,
  defer,
}) {
  // Initialize data layer manager
  const dataManager = new LayerLifecycle(viewer, {
    allowQaRegistration,
  });
  defer(async () => {
    await dataManager.destroyAll();
    if (dataManager.layers.size)
      throw new Error(
        `Data layers could not be destroyed: ${[...dataManager.layers.keys()].join(', ')}`,
      );
  });
  const presentation = new LayerPresentation(dataManager, {
    weatherClock: catalog?.weatherClock,
  });
  defer(() => presentation.destroy());
  onData?.(dataManager);
  if (!catalog?.layers || !catalog?.metadata)
    throw new TypeError('An application layer catalog is required');
  for (const layer of catalog.layers) dataManager.register(layer);
  for (const layer of catalog.layers) layer.attachDataManager?.(dataManager);
  for (const layer of catalog.layers)
    layer.attachMapStackController?.(mapStackController);
  // Restoration starts only after the caller's complete registry is sealed.
  dataManager.finalizeRegistrations(catalog.metadata);
  // Fresh keyless sessions get the free 3D-buildings fallback by default;
  // any stored or shared layer state (or a photoreal tileset) wins instead.
  maybeAutoEnableKeylessBuildings({ dataManager, tileset });
  if (allowQaRegistration) {
    window.__gevQaRegisterLayer = (targetManager, layerModule) => {
      if (targetManager !== dataManager)
        throw new Error('QA layer manager mismatch');
      return dataManager.registerForQa(layerModule);
    };
    window.__gevQaUnregisterLayer = (targetManager, layerId) => {
      if (targetManager !== dataManager)
        throw new Error('QA layer manager mismatch');
      return dataManager.unregisterForQa(layerId);
    };
    const register = window.__gevQaRegisterLayer;
    const unregister = window.__gevQaUnregisterLayer;
    defer(() => {
      if (window.__gevQaRegisterLayer === register)
        delete window.__gevQaRegisterLayer;
      if (window.__gevQaUnregisterLayer === unregister)
        delete window.__gevQaUnregisterLayer;
    });
  }
  presentation.mount(document.getElementById('data-toggles'));
  styleManager.attachDataManager(dataManager);
  defer(createCyberSonarScene(viewer, dataManager));

  return { dataManager, catalog, presentation };
}
