/**
 * DOT weather-cam mesh — model. Wave 3 (1.7).
 *
 * Pure logic (no Cesium, no DOM): fetch the /api/dot-cams snapshot,
 * nearest-camera selection, and still-image URL building. Stills are served
 * through /api/dot-cams/image (302 to allow-listed DOT hosts) so the panel
 * never needs the raw upstream URL.
 */

const API_URL = '/api/dot-cams';

export async function fetchDotCams({ fetchImpl, signal, state } = {}) {
  const f = fetchImpl || fetch;
  const url = state ? `${API_URL}?state=${encodeURIComponent(state)}` : API_URL;
  const response = await f(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`dotcams_http_${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.cameras)) throw new Error('dotcams_bad_shape');
  return body;
}

/** Great-circle distance in km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const d2r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * d2r) / 2) ** 2 +
    Math.cos(lat1 * d2r) *
      Math.cos(lat2 * d2r) *
      Math.sin(((lon2 - lon1) * d2r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** n nearest cameras to a point, each annotated with distKm. */
export function nearestCams(cameras, lat, lon, n = 12) {
  return (cameras ?? [])
    .filter((c) => Number.isFinite(c?.lat) && Number.isFinite(c?.lon))
    .map((c) => ({ ...c, distKm: haversineKm(lat, lon, c.lat, c.lon) }))
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, Math.max(1, n));
}

/** Panel image URL for a camera (cache-busted by the caller when refreshing). */
export function weatherCamStillUrl(cam) {
  if (!cam?.imageUrl) return null;
  return `${API_URL}/image?u=${encodeURIComponent(cam.imageUrl)}`;
}
