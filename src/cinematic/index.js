/**
 * index.js — SATWQ cinematic pack integration.
 *
 * initCinematic({ components }) wires the camera-director auto-tour and the
 * WebAudio ambient engine into a started standalone application. Everything
 * is fail-soft: a failure here returns null and must never break the main
 * app. The tour and the ambient engine stay OFF until the user starts them
 * (voice action, console, or a future HUD button) — booting into an
 * auto-flying camera would fight the operator.
 */
import * as Cesium from 'cesium';
import { TourDirector } from './tourDirector.js';
import { AmbientEngine } from './ambientEngine.js';

export function initCinematic({ components } = {}) {
  const viewer = components?.scene?.viewer ?? null;
  const dataManager = components?.data?.dataManager ?? null;
  if (!viewer || !dataManager) return null;

  // Activate the glassmorphism HUD theme (scoped to .satwq-hud).
  try {
    document.getElementById('intel-hud')?.classList?.add('satwq-hud');
  } catch {
    /* non-fatal */
  }

  const tour = new TourDirector({
    viewer,
    getLayers: () =>
      [...dataManager.layers.values()].map((entry) => ({
        id: entry?.module?.id ?? entry?.id,
        getStats: () => {
          try {
            return entry?.module?.getStats?.() ?? null;
          } catch {
            return null;
          }
        },
      })),
    isEnabled: (layerId) => !!dataManager.layers.get(layerId)?.enabled,
    destinationFor: (view) =>
      Cesium.Cartesian3.fromDegrees(view.longitude, view.latitude, view.heightM),
    requestRender: () => {
      try {
        viewer.scene?.requestRender?.();
      } catch {
        /* ignore */
      }
    },
  });

  const ambient = new AmbientEngine();

  const cinematic = { tour, ambient };
  // Reachable from the console and future voice/HUD controls.
  // Tour and ambient stay off until explicitly started.
  try {
    window.satwqCinematic = cinematic;
  } catch {
    /* ignore */
  }
  return cinematic;
}

export { TourDirector } from './tourDirector.js';
export { AmbientEngine } from './ambientEngine.js';
export { withTourVoiceActions } from './voiceTourActions.js';
export { animateStatValue, formatCompact, formatInt } from './layerStatsTicker.js';
