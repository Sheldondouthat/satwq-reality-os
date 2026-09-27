/**
 * Fire-spread projection (F9) — pure geometry, no Cesium, no network.
 *
 * First-order downwind-ellipse model: each ignition grows an elliptical ring
 * per requested hour, elongated along the downwind bearing. This is a
 * GEOMETRIC projection, not a Rothermel/FARSITE physics simulation —
 * everything it renders must be labeled "modeled projection".
 *
 * Ignition inputs (keyless tier):
 *   - NOAA HMS smoke polygon centroids (/api/hms-smoke, keyless KML) as
 *     ignition PROXIES — a smoke centroid is evidence of fire, not a mapped
 *     ignition point. Wire via INTEGRATION.md's smokeCentroidIgnitions().
 *   - NIFC WFIGS perimeters (src/layers/perimeters/) incident anchors.
 * KEYED UPGRADE PATH: replace ignitions with FIRMS active-fire hotspots
 *   (/api/firms — NOT-CONFIGURED in prod) and the default wind below with
 *   sampled GRIB wind (/api/wind — excluded on Pages; server-side GRIB
 *   sampling, or a /api/weather current-wind readout at the ignition).
 *
 * Wind convention: meteorological `fromDeg` — the compass bearing the wind
 * blows FROM (270 = from the west, spreading fire eastward). Speed in km/h.
 */

/** Honest default: user-adjustable stand-in until measured wind is wired. */
export const DEFAULT_WIND = Object.freeze({
  fromDeg: 270,
  speedKmh: 20,
  // Rendered verbatim next to every projection using this default.
  label:
    'Assumed wind: from W at 20 km/h — modeled projection, not measured. ' +
    'Adjust per-ignition, or wire /api/wind for measured wind (see INTEGRATION.md).',
});

export const SPREAD_HOURS_DEFAULT = Object.freeze([6, 12, 24]);

const DEG = Math.PI / 180;
const KM_PER_DEG_LAT = 111.32;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clampFinite = (v, fallback) =>
  Number.isFinite(v) ? v : fallback;

/**
 * Validate one ignition. Returns null when invalid (caller skips + counts).
 */
export function normalizeIgnition(raw) {
  const lat = Number(raw?.lat);
  const lon = Number(raw?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat,
    lon,
    label: typeof raw?.label === 'string' ? raw.label.slice(0, 120) : null,
    source: typeof raw?.source === 'string' ? raw.source.slice(0, 120) : null,
  };
}

export function normalizeWind(raw) {
  const fromDeg = clampFinite(Number(raw?.fromDeg), DEFAULT_WIND.fromDeg);
  const speedKmh = clamp(
    clampFinite(Number(raw?.speedKmh), DEFAULT_WIND.speedKmh),
    0,
    250,
  );
  return {
    fromDeg: ((fromDeg % 360) + 360) % 360,
    speedKmh,
    label:
      typeof raw?.label === 'string' && raw.label
        ? raw.label.slice(0, 240)
        : DEFAULT_WIND.label,
    measured: raw?.measured === true,
  };
}

const normalizeHours = (hours) =>
  (Array.isArray(hours) ? hours : SPREAD_HOURS_DEFAULT)
    .map(Number)
    .filter((h) => Number.isFinite(h) && h > 0 && h <= 72)
    .sort((a, b) => a - b)
    .slice(0, 8);

/**
 * Head-fire rate of spread (km/h) from wind speed — a tuned stand-in curve,
 * documented as non-physical. Upgrade path: Rothermel/Scott-Burgan ROS with
 * fuel-model + slope inputs when those feeds exist.
 */
export function headRateOfSpreadKmh(speedKmh) {
  return clamp(0.4 + 0.22 * clampFinite(speedKmh, 0), 0.2, 15);
}

/**
 * Project spread rings.
 * @param {object} args
 * @param {Array<{lat:number,lon:number,label?,source?}>} args.ignitions
 * @param {{fromDeg:number,speedKmh:number,label?,measured?}} args.wind
 * @param {number[]} args.hours - projection horizons in hours
 * @param {number} [args.segments=48] - ring resolution
 * @returns {{ rings: Array, skipped: number, wind: object }}
 *   ring: { ignitionIndex, ignition, hour, polygon:[[lon,lat]...closed],
 *           headRunKm, flankRunKm, areaKm2, centroid:{lat,lon}, downwindBearingDeg }
 */
export function projectSpread({ ignitions, wind, hours, segments = 48 } = {}) {
  const w = normalizeWind(wind);
  const hs = normalizeHours(hours);
  const toDeg = (w.fromDeg + 180) % 360; // bearing the fire travels toward
  const ros = headRateOfSpreadKmh(w.speedKmh);
  // Length-to-breadth ratio grows with wind (documented stand-in).
  const aspect = clamp(1 + 1.15 * Math.sqrt(w.speedKmh / 40), 1, 8);
  const segs = clamp(Math.floor(clampFinite(segments, 48)), 12, 360);

  const rings = [];
  let skipped = 0;
  const ignList = Array.isArray(ignitions) ? ignitions : [];
  for (const [ignitionIndex, raw] of ignList.entries()) {
    const ignition = normalizeIgnition(raw);
    if (!ignition) {
      skipped += 1;
      continue;
    }
    for (const hour of hs) {
      const headRun = ros * hour; // downwind head distance, km
      const backRun = 0.3 * headRun; // backing fire upwind
      const a = (headRun + backRun) / 2; // semi-major axis
      const b = a / aspect; // semi-minor axis
      const centerOffset = (headRun - backRun) / 2; // ellipse center downwind of ignition
      const ring = [];
      const cosB = Math.cos(toDeg * DEG);
      const sinB = Math.sin(toDeg * DEG);
      const kmPerDegLon = KM_PER_DEG_LAT * Math.cos(ignition.lat * DEG) || 1e-6;
      for (let i = 0; i < segs; i++) {
        const t = (2 * Math.PI * i) / segs;
        // Ellipse axes: x along downwind, y crosswind (km from ignition).
        const xKm = a * Math.cos(t) + centerOffset;
        const yKm = b * Math.sin(t);
        // Rotate: downwind bearing convention (0=N, 90=E).
        const dLat = (xKm * cosB - yKm * sinB) / KM_PER_DEG_LAT;
        const dLon = (xKm * sinB + yKm * cosB) / kmPerDegLon;
        ring.push([ignition.lon + dLon, ignition.lat + dLat]);
      }
      ring.push([...ring[0]]); // close the ring
      // Approximate centroid (mean of ring points) for downwind-bias checks.
      let cx = 0;
      let cy = 0;
      for (const [lo, la] of ring) {
        cx += lo;
        cy += la;
      }
      cx /= ring.length;
      cy /= ring.length;
      rings.push({
        ignitionIndex,
        ignition,
        hour,
        polygon: ring,
        headRunKm: headRun,
        flankRunKm: b,
        areaKm2: Math.PI * a * b,
        centroid: { lat: cy, lon: cx },
        downwindBearingDeg: toDeg,
        modeled: true,
      });
    }
  }
  return { rings, skipped, wind: w };
}

/** GeoJSON-ish FeatureCollection for one time step. */
export function ringsToFeatureCollection(rings, hour) {
  const features = rings
    .filter((r) => r.hour === hour)
    .map((r, i) => ({
      type: 'Feature',
      properties: {
        ignitionIndex: r.ignitionIndex,
        hour: r.hour,
        label: r.ignition.label,
        source: r.ignition.source,
        headRunKm: +r.headRunKm.toFixed(2),
        areaKm2: +r.areaKm2.toFixed(2),
        modeled: true,
      },
      geometry: { type: 'Polygon', coordinates: [r.polygon] },
      id: `spread:${r.ignitionIndex}:${r.hour}:${i}`,
    }));
  return { type: 'FeatureCollection', features };
}
