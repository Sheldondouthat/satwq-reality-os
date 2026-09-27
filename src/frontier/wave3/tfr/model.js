/**
 * TFR lockdown overlay — model. Wave 3 (1.5).
 *
 * Pure logic (no Cesium, no DOM): fetch the /api/tfrs snapshot, point-in-ring
 * tests, flight-inside-TFR flagging, and trivial crosses with fire
 * perimeters + VAAC ash advisory volumes.
 */

const API_URL = '/api/tfrs';
const MIL_AIRCRAFT_URL = '/api/adsblol/mil';

export async function fetchTfrs({ fetchImpl, signal } = {}) {
  const f = fetchImpl || fetch;
  const response = await f(API_URL, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`tfrs_http_${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.tfrs)) throw new Error('tfrs_bad_shape');
  return body;
}

/** Ray-casting point-in-ring for [lon,lat] rings. */
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Centroid of the first ring, for marker placement. */
export function tfrCentroid(tfr) {
  const ring = tfr?.rings?.[0];
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let lon = 0;
  let lat = 0;
  for (const [lo, la] of ring) {
    lon += lo;
    lat += la;
  }
  return { lon: lon / ring.length, lat: lat / ring.length };
}

/**
 * Flag aircraft inside any active TFR polygon.
 * aircraft: [{id, lon, lat, altFt}] ; returns [{aircraft, tfr}].
 * A TFR with no geometry can never match (honest: not flagged).
 */
export function flagFlightsInsideTfrs(tfrs, aircraft) {
  const hits = [];
  for (const ac of aircraft ?? []) {
    if (!Number.isFinite(ac?.lon) || !Number.isFinite(ac?.lat)) continue;
    for (const tfr of tfrs ?? []) {
      if (!Array.isArray(tfr.rings) || tfr.rings.length === 0) continue;
      for (const ring of tfr.rings) {
        if (pointInRing(ac.lon, ac.lat, ring)) {
          hits.push({ aircraft: ac, tfr });
          break;
        }
      }
    }
  }
  return hits;
}

/**
 * Trivial cross: TFRs whose bbox intersects any fire-perimeter bbox.
 * perimeters: [{bbox:[minLon,minLat,maxLon,maxLat]}] (from /api/fire-perimeters).
 */
export function crossTfrsWithFires(tfrs, perimeters) {
  const boxes = (perimeters ?? []).filter((p) => Array.isArray(p?.bbox) && p.bbox.length === 4);
  const ringBbox = (ring) => {
    let minLon = 180;
    let maxLon = -180;
    let minLat = 90;
    let maxLat = -90;
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    return [minLon, minLat, maxLon, maxLat];
  };
  const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
  const hits = [];
  for (const tfr of tfrs ?? []) {
    for (const ring of tfr.rings ?? []) {
      const box = ringBbox(ring);
      for (const p of boxes) {
        if (overlaps(box, p.bbox)) {
          hits.push({ tfr, perimeter: p });
          break;
        }
      }
      if (hits.some((h) => h.tfr === tfr)) break;
    }
  }
  return hits;
}

/** Fetch military aircraft from the keyless adsb.lol mil proxy. */
export async function fetchMilAircraft({ fetchImpl, signal } = {}) {
  const f = fetchImpl || fetch;
  const response = await f(MIL_AIRCRAFT_URL, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`adsblol_mil_${response.status}`);
  const body = await response.json();
  return (Array.isArray(body?.ac) ? body.ac : [])
    .filter((a) => Number.isFinite(a?.lon) && Number.isFinite(a?.lat))
    .map((a) => ({
      id: String(a.hex ?? a.flight ?? 'unknown').trim(),
      flight: String(a.flight ?? '').trim() || null,
      lon: a.lon,
      lat: a.lat,
      altFt: Number.isFinite(a.alt_baro) ? a.alt_baro : null,
    }));
}

export const TFR_TYPE_COLORS = {
  VIP: '#ff4d6d',
  HAZARDS: '#ff9f1c',
  'SPACE OPERATIONS': '#9d4edd',
  SPORTING: '#2ec4b6',
  DISASTER: '#e71d36',
  SECURITY: '#ff4d6d',
};
export const tfrColorFor = (type) => TFR_TYPE_COLORS[String(type ?? '').toUpperCase()] ?? '#ff9f1c';
