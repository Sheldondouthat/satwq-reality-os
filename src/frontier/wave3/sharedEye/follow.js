/**
 * Shared God's eye — follow-mode fallback.
 *
 * When WebRTC can't connect (symmetric NAT, UDP blocked), peers fall back to
 * copy-paste camera state: export your camera as a short code, paste a peer's
 * code to fly to their view. No network at all — works over any chat app.
 */

/** Export a camera state as a compact paste-ready code. */
export function exportCameraState(camera) {
  if (!camera || !Number.isFinite(camera.lon) || !Number.isFinite(camera.lat) || !Number.isFinite(camera.height)) {
    return null;
  }
  const compact = {
    v: 1,
    lon: Math.round(camera.lon * 1e4) / 1e4,
    lat: Math.round(camera.lat * 1e4) / 1e4,
    h: Math.round(camera.height),
    hd: Math.round((camera.heading ?? 0) * 100) / 100,
    p: Math.round((camera.pitch ?? -60) * 100) / 100,
  };
  const json = JSON.stringify(compact);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return `SATWQ-EYE:${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** Parse a pasted follow code back to a camera state. Null when invalid. */
export function importCameraState(code) {
  if (typeof code !== 'string') return null;
  const body = code.trim().replace(/^SATWQ-EYE:/, '');
  if (!body.length || body.length > 2000) return null;
  try {
    const b64 = body.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    if (!obj || obj.v !== 1) return null;
    const { lon, lat, h, hd, p } = obj;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(h)) return null;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90 || h < 0 || h > 1e9) return null;
    return { lon, lat, height: h, heading: Number.isFinite(hd) ? hd : 0, pitch: Number.isFinite(p) ? p : -60 };
  } catch {
    return null;
  }
}

/**
 * Read the current camera state from a Cesium viewer. Null when unavailable.
 * Pure against a viewer-like object for testability.
 */
export function readViewerCamera(viewer) {
  try {
    const carto = viewer?.camera?.positionCartographic;
    if (!carto) return null;
    const lon = (carto.longitude * 180) / Math.PI;
    const lat = (carto.latitude * 180) / Math.PI;
    const height = carto.height;
    const heading = (viewer.camera.heading * 180) / Math.PI || 0;
    const pitch = (viewer.camera.pitch * 180) / Math.PI || 0;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(height)) return null;
    return { lon, lat, height, heading, pitch };
  } catch {
    return null;
  }
}

/**
 * Fly a Cesium viewer to a camera state. Returns a promise; never throws.
 * `cesiumImport` is injectable (defaults to dynamic `import('cesium')`).
 */
export async function flyViewerTo(viewer, camera, cesiumImport = () => import('cesium')) {
  if (!viewer || !camera) return false;
  try {
    const { Cartesian3, Math: CMath } = await cesiumImport();
    await new Promise((resolve) => {
      viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(camera.lon, camera.lat, camera.height),
        orientation: {
          heading: CMath.toRadians(camera.heading ?? 0),
          pitch: CMath.toRadians(camera.pitch ?? -60),
          roll: 0,
        },
        duration: 2.0,
        complete: () => resolve(true),
        cancel: () => resolve(false),
      });
    });
    return true;
  } catch {
    return false;
  }
}
