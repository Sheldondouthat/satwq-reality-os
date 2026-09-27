/**
 * WebXR mode — equirect panorama painter.
 *
 * Paints the "inside of the planet" view onto an offscreen 2D canvas:
 * deep-space gradient, starfield, graticule, a stylized limb glow, and the
 * live data sprites. The canvas becomes the texture for the WebGL inverted
 * sphere (xrSession.js) and the source for the 2D fallback viewer.
 *
 * Needs `document`; returns null outside a DOM. Pure coordinate helpers live
 * in math.js and are unit-tested there.
 */
import { equirectUV, uvToPixel } from './math.js';

export const PANO_WIDTH = 2048;
export const PANO_HEIGHT = 1024;

function makeStars(seed, count, width, height) {
  // Deterministic LCG so the sky is stable between repaints.
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const stars = [];
  for (let i = 0; i < count; i += 1) {
    stars.push({
      x: Math.floor(rand() * width),
      y: Math.floor(rand() * height),
      r: rand() < 0.06 ? 1.6 : rand() < 0.3 ? 1.1 : 0.7,
      a: 0.35 + rand() * 0.65,
    });
  }
  return stars;
}

const STARS = makeStars(0xC0FFEE, 900, PANO_WIDTH, PANO_HEIGHT);

/**
 * Paint the panorama. `sprites` = [{lon, lat, color, size, label}].
 * Returns the canvas (reused across calls when passed as `reuse`).
 */
export function paintPanorama(sprites = [], reuse = null) {
  if (typeof document === 'undefined') return null;
  const canvas = reuse || document.createElement('canvas');
  canvas.width = PANO_WIDTH;
  canvas.height = PANO_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Deep-space gradient.
  const bg = ctx.createLinearGradient(0, 0, 0, PANO_HEIGHT);
  bg.addColorStop(0, '#02040a');
  bg.addColorStop(0.5, '#060b18');
  bg.addColorStop(1, '#02040a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, PANO_WIDTH, PANO_HEIGHT);

  // Stars.
  for (const st of STARS) {
    ctx.globalAlpha = st.a;
    ctx.fillStyle = '#cfe4ff';
    ctx.beginPath();
    ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Graticule every 30°.
  ctx.strokeStyle = 'rgba(120,180,255,.14)';
  ctx.lineWidth = 1;
  for (let lon = -180; lon < 180; lon += 30) {
    const x = ((lon + 180) / 360) * PANO_WIDTH;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, PANO_HEIGHT);
    ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = ((90 - lat) / 180) * PANO_HEIGHT;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(PANO_WIDTH, y);
    ctx.stroke();
  }

  // Limb glow bands (the "planet's edge" you stand inside of).
  const glow = ctx.createLinearGradient(0, 0, 0, PANO_HEIGHT);
  glow.addColorStop(0, 'rgba(80,160,255,.10)');
  glow.addColorStop(0.5, 'rgba(80,160,255,0)');
  glow.addColorStop(1, 'rgba(80,160,255,.10)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, PANO_WIDTH, PANO_HEIGHT);

  // Live data sprites with halos.
  for (const sp of sprites) {
    if (!Number.isFinite(sp.lon) || !Number.isFinite(sp.lat)) continue;
    const { u, v } = equirectUV(sp.lon, sp.lat);
    const { x, y } = uvToPixel(u, v, PANO_WIDTH, PANO_HEIGHT);
    const size = Math.max(4, Math.min(18, Number(sp.size) || 7));
    const color = typeof sp.color === 'string' ? sp.color : '#9fc2ff';
    const halo = ctx.createRadialGradient(x, y, 0, x, y, size * 3);
    halo.addColorStop(0, color);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, size * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, size / 2.4, 0, Math.PI * 2);
    ctx.fill();
    // Dateline wrap: also paint the wrapped copy so sprites near ±180
    // don't pop at the seam.
    for (const ox of [-PANO_WIDTH, PANO_WIDTH]) {
      const wx = x + ox;
      if (wx < -size * 3 || wx > PANO_WIDTH + size * 3) continue;
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(wx, y, size * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(wx, y, size / 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Caption strip.
  ctx.fillStyle = 'rgba(159,194,255,.75)';
  ctx.font = '28px system-ui, sans-serif';
  ctx.fillText('SATWQ · inside the planet · live data sprites · v1', 28, PANO_HEIGHT - 28);

  return canvas;
}
