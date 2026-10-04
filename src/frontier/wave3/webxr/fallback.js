/**
 * WebXR mode — 2D fallback viewer.
 *
 * A fullscreen drag-to-look 360 viewer sampling the equirect panorama. Works
 * on desktop browsers and anywhere immersive-vr is unavailable (including
 * when the Quest browser is used in a plain tab). Clearly labeled as the
 * non-XR mode in the UI.
 */
import { viewWindow, dragLook } from './math.js';
import { PANO_WIDTH, PANO_HEIGHT } from './panorama.js';

export const FALLBACK_FOV_H = 90;
export const FALLBACK_FOV_V = 60;

/**
 * Create the fallback viewer overlay.
 * `getPanorama()` returns the current panorama canvas (may update live).
 * Returns { element, destroy }.
 */
export function createFallbackViewer(getPanorama) {
  if (typeof document === 'undefined') return null;

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10000;background:#000;display:flex;' +
    'flex-direction:column;font:12px/1.45 system-ui,sans-serif;color:#dfe9ff;';

  const bar = document.createElement('div');
  bar.style.cssText =
    'display:flex;gap:8px;align-items:center;padding:8px 12px;' +
    'background:rgba(8,12,20,.9);border-bottom:1px solid rgba(120,180,255,.25);';
  const label = document.createElement('div');
  label.innerHTML =
    '<b>◈ inside the planet — 360 viewer</b> <span style="color:#9db4d8">(non-XR fallback; drag to look around)</span>';
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  const exitBtn = document.createElement('button');
  exitBtn.textContent = '✕ exit';
  exitBtn.style.cssText =
    'padding:5px 12px;border-radius:20px;border:1px solid rgba(120,180,255,.35);' +
    'background:rgba(30,45,70,.6);color:#dfe9ff;cursor:pointer;';
  bar.append(label, spacer, exitBtn);
  overlay.appendChild(bar);

  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'flex:1;width:100%;height:100%;cursor:grab;touch-action:none;';
  overlay.appendChild(canvas);

  const state = { yawDeg: 0, pitchDeg: 0 };
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function render() {
    const pano = getPanorama();
    if (!pano) return;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const win = viewWindow(
      state.yawDeg,
      state.pitchDeg,
      FALLBACK_FOV_H,
      FALLBACK_FOV_V,
    );
    // Sample the panorama window with u-wrap.
    const srcW = (win.u1 - win.u0) * PANO_WIDTH;
    const srcX = win.u0 * PANO_WIDTH;
    const srcY = win.v0 * PANO_HEIGHT;
    const srcH = (win.v1 - win.v0) * PANO_HEIGHT;
    const drawWrapped = (sx) => {
      const wrapped = ((sx % PANO_WIDTH) + PANO_WIDTH) % PANO_WIDTH;
      const take = Math.min(srcW, PANO_WIDTH - wrapped);
      const dw = (take / srcW) * w;
      const dx = ((wrapped - srcX) / srcW) * w;
      ctx.drawImage(pano, wrapped, srcY, take, srcH, dx, 0, dw, h);
      return take;
    };
    let taken = drawWrapped(srcX);
    if (taken < srcW) {
      // Second strip from the wrapped edge.
      const remain = srcW - taken;
      const dx = (taken / srcW) * w;
      const dw = (remain / srcW) * w;
      ctx.drawImage(pano, 0, srcY, remain, srcH, dx, 0, dw, h);
    }
  }

  const raf = { id: 0 };
  const loop = () => {
    render();
    raf.id = requestAnimationFrame(loop);
  };

  const onDown = (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
  };
  const onMove = (e) => {
    if (!dragging) return;
    const next = dragLook(state, e.clientX - lastX, e.clientY - lastY);
    state.yawDeg = next.yawDeg;
    state.pitchDeg = next.pitchDeg;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onUp = () => {
    dragging = false;
    canvas.style.cursor = 'grab';
  };

  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  function destroy() {
    cancelAnimationFrame(raf.id);
    canvas.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    overlay.remove();
  }
  exitBtn.addEventListener('click', destroy);

  document.body.appendChild(overlay);
  loop();
  return { element: overlay, destroy, _state: state };
}
