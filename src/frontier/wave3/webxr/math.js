/**
 * WebXR mode — pure projection math (no DOM, no WebGL; fully testable).
 *
 * The v1 viewer renders an equirectangular "inside the planet" panorama:
 * the camera sits at the sphere's center and the panorama is textured on the
 * inside of the sphere. All helpers below are pure.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** Clamp helper. */
export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Wrap longitude to [-180, 180). */
export function wrapLon(lon) {
  let l = lon % 360;
  if (l < -180) l += 360;
  if (l >= 180) l -= 360;
  return l;
}

/**
 * lon/lat (deg) → unit vector on the sphere (right-handed, y-up).
 * Pure — used by the WebGL sphere mesh and the sprite projector.
 */
export function lonLatToVec3(lon, lat) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  const sinPhi = Math.sin(phi);
  return {
    x: -(sinPhi * Math.cos(theta)),
    y: Math.cos(phi),
    z: sinPhi * Math.sin(theta),
  };
}

/**
 * lon/lat (deg) → equirect UV in [0,1]^2 (u wraps, v is clamped).
 * Matches the standard mapping used by equirect textures: u=0 at lon -180.
 */
export function equirectUV(lon, lat) {
  const u = ((wrapLon(lon) + 180) / 360) % 1;
  const v = clamp((90 - lat) / 180, 0, 1);
  return { u, v };
}

/**
 * UV → pixel coordinates on a WxH panorama canvas.
 */
export function uvToPixel(u, v, width, height) {
  return { x: Math.round(u * (width - 1)), y: Math.round(v * (height - 1)) };
}

/**
 * Look direction (yaw, pitch in degrees) → unit vector.
 * yaw=0 faces lon 0 at the equator; positive yaw turns east.
 */
export function lookDir(yawDeg, pitchDeg) {
  const yaw = yawDeg * DEG;
  const pitch = clamp(pitchDeg, -89.9, 89.9) * DEG;
  const cp = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

/**
 * Stereo eye viewports for an immersive framebuffer: left eye [0, w/2),
 * right eye [w/2, w). Returns {left:{x,y,w,h}, right:{...}}.
 */
export function eyeViewports(framebufferWidth, framebufferHeight) {
  const half = Math.floor(framebufferWidth / 2);
  return {
    left: { x: 0, y: 0, w: half, h: framebufferHeight },
    right: { x: half, y: 0, w: framebufferWidth - half, h: framebufferHeight },
  };
}

/**
 * Drag-look state update for the 2D fallback viewer.
 * dx/dy are drag deltas in pixels; returns the new {yawDeg, pitchDeg}.
 */
export function dragLook({ yawDeg, pitchDeg }, dx, dy, pixelsPerDegree = 4) {
  return {
    yawDeg: yawDeg - dx / pixelsPerDegree,
    pitchDeg: clamp(pitchDeg + dy / pixelsPerDegree, -85, 85),
  };
}

/**
 * Given a look direction and horizontal/vertical FOV, compute the equirect
 * window (u0,u1,v0,v1) the fallback viewer should sample from the panorama.
 * Handles u-wrap (returns u1 possibly > u0+1; the sampler must wrap).
 */
export function viewWindow(yawDeg, pitchDeg, fovHdeg, fovVdeg) {
  const uCenter = (wrapLon(yawDeg) + 180) / 360;
  const vCenter = clamp((90 - pitchDeg) / 180, 0, 1);
  const du = fovHdeg / 360;
  const dv = fovVdeg / 180;
  return {
    u0: uCenter - du / 2,
    u1: uCenter + du / 2,
    v0: clamp(vCenter - dv / 2, 0, 1),
    v1: clamp(vCenter + dv / 2, 0, 1),
  };
}

/**
 * Feature-detect WebXR immersive-vr. Pure against an injected navigator-like
 * object so tests can fake it; real code passes window.navigator.
 */
export async function xrImmersiveSupported(navigatorLike) {
  try {
    if (!navigatorLike || !navigatorLike.xr || typeof navigatorLike.xr.isSessionSupported !== 'function')
      return false;
    return await navigatorLike.xr.isSessionSupported('immersive-vr');
  } catch {
    return false;
  }
}
