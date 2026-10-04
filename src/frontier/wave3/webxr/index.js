/**
 * WebXR mode — fail-soft mount (wave3, part C item 2).
 *
 * `initWebXR()` mounts a floating "step inside the planet" button:
 *   - if `navigator.xr` reports immersive-vr support → starts a real stereo
 *     WebXR session (hand-rolled WebGL inverted sphere, live data sprites);
 *   - otherwise → opens the fullscreen 360 drag-to-look fallback viewer.
 *
 * Honest v1 scope, stated in the UI: this is an immersive live-data
 * diorama, NOT the Cesium globe ported to XR.
 */
import { fetchSprites } from './dataSprites.js';
import { paintPanorama } from './panorama.js';
import { startImmersiveSession, startPanoramaRefresh } from './xrSession.js';
import { createFallbackViewer } from './fallback.js';

export function initWebXR() {
  if (typeof document === 'undefined') return null;
  const cleanups = [];
  try {
    let panoramaCanvas = null;
    const getSprites = () => fetchSprites();
    const stopRefresh = startPanoramaRefresh(getSprites, (canvas) => {
      panoramaCanvas = canvas;
    });
    cleanups.push(stopRefresh);

    const ensurePanorama = async () => {
      if (!panoramaCanvas) {
        panoramaCanvas = paintPanorama(await getSprites());
      }
      return panoramaCanvas;
    };

    let immersive = null;
    let fallback = null;

    const closeAll = async () => {
      if (fallback) {
        fallback.destroy();
        fallback = null;
      }
      if (immersive) {
        const s = immersive;
        immersive = null;
        await s.stop();
      }
    };

    const btn = document.createElement('button');
    btn.textContent = '◉ step inside the planet (v1)';
    btn.setAttribute(
      'aria-label',
      'Enter the immersive inside-the-planet viewer',
    );
    btn.title =
      'v1: immersive 360 diorama with live data sprites — not the full Cesium globe in XR';
    btn.style.cssText =
      'position:fixed;right:12px;bottom:52px;z-index:9990;padding:7px 12px;border-radius:20px;' +
      'border:1px solid rgba(120,180,255,.35);background:rgba(8,12,20,.88);color:#9fc2ff;' +
      'cursor:pointer;font-size:11px;letter-spacing:.06em;';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await closeAll();
        const pano = await ensurePanorama();
        if (!pano) throw new Error('panorama unavailable');
        try {
          immersive = await startImmersiveSession(pano);
          immersive.session.addEventListener('end', () => {
            immersive = null;
          });
        } catch (xrError) {
          // Honest fallback: plain-tab 360 viewer.
          console.info(
            '[webxr] immersive-vr unavailable, using 360 fallback:',
            xrError?.message,
          );
          fallback = createFallbackViewer(() => panoramaCanvas);
        }
      } catch (error) {
        console.warn('[webxr] viewer failed:', error);
      } finally {
        btn.disabled = false;
      }
    });
    document.body.appendChild(btn);
    cleanups.push(() => btn.remove());

    return () => {
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      closeAll();
    };
  } catch (error) {
    console.warn('[webxr] mount failed:', error);
    return null;
  }
}

export { fetchSprites, paintPanorama };
