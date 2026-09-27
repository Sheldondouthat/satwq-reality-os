/**
 * F5 — NOAA OVATION aurora: pure grid parsing, color ramp, and night mask.
 *
 * The live SWPC endpoint `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json`
 * (verified 2026-09-27: HTTP 200, CORS `*`) returns:
 *   { "Observation Time", "Forecast Time",
 *     "Data Format": "[Longitude, Latitude, Aurora]",
 *     "coordinates": [[lon, lat, aurora], ...] }
 * with lon 0..359, lat -90..90 at 1° resolution (65,160 cells), aurora ~0..100.
 *
 * Everything here is pure (no Cesium, no DOM); the index builds the canvas
 * texture from `ovationImageBuffer`. Night masking uses the shared solar
 * ephemeris via a caller-supplied subsolar point.
 */

export const OVATION_GRID_LONS = 360;
export const OVATION_GRID_LATS = 181;
/** Reference max for the color ramp (legend labels "High (30+)"). */
export const OVATION_RAMP_MAX = 30;

/**
 * Validate and index an OVATION payload. Returns
 * `{ observationTimeMs, forecastTimeMs, count, values }` where `values` is a
 * Float32Array of length 360*181, indexed `[latIdx * 360 + lonIdx]`
 * (lonIdx = OVATION lon 0..359, latIdx = lat + 90). Throws on malformed input.
 */
export function parseOvationGrid(payload) {
  const coords = payload?.coordinates;
  if (!payload || typeof payload !== 'object' || !Array.isArray(coords))
    throw new Error('Malformed OVATION response: missing coordinates array');
  const obsMs = Date.parse(payload['Observation Time']);
  const fcstMs = Date.parse(payload['Forecast Time']);
  if (!Number.isFinite(obsMs))
    throw new Error('Malformed OVATION response: bad Observation Time');
  const values = new Float32Array(OVATION_GRID_LONS * OVATION_GRID_LATS);
  let count = 0;
  for (const row of coords) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const [lon, lat, aurora] = row;
    if (
      !Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(aurora) ||
      lon < 0 || lon > 359 || lat < -90 || lat > 90
    )
      continue;
    const lonIdx = Math.round(lon);
    const latIdx = Math.round(lat) + 90;
    if (lonIdx > 359 || latIdx > 180) continue;
    values[latIdx * OVATION_GRID_LONS + lonIdx] = Math.max(0, aurora);
    count++;
  }
  if (count === 0) throw new Error('Malformed OVATION response: no valid grid cells');
  return {
    observationTimeMs: obsMs,
    forecastTimeMs: Number.isFinite(fcstMs) ? fcstMs : null,
    count,
    values,
  };
}

/**
 * Aurora intensity (0..~100) -> [r, g, b, a] bytes.
 * 0 is fully transparent; the ramp runs green -> yellow -> orange -> red,
 * saturating at OVATION_RAMP_MAX.
 */
export function ovationRgba(value, maxRef = OVATION_RAMP_MAX) {
  if (!Number.isFinite(value) || value <= 0) return [0, 0, 0, 0];
  const t = Math.min(1, value / maxRef);
  // stops: 0.00 #22ff66 (green) -> 0.35 #ffe14d (yellow) -> 0.65 #ff8a2a (orange) -> 1.00 #ff2a2a (red)
  const stops = [
    [0.0, 34, 255, 102],
    [0.35, 255, 225, 77],
    [0.65, 255, 138, 42],
    [1.0, 255, 42, 42],
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  const alpha = Math.round(70 + 185 * t); // faint wash at low values, solid at high
  return [
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
    Math.round(a[3] + (b[3] - a[3]) * f),
    alpha,
  ];
}

const RAD = Math.PI / 180;

/** Great-circle angular distance in degrees between two lon/lat points. */
export function angularDistanceDeg(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) / RAD;
}

/**
 * Night test: true when the point is on the night side of the terminator,
 * with a twilight margin (default 6°) so the aurora fades at the day edge.
 */
export function isNight(lonDeg, latDeg, subLon, subLat, twilightDeg = 6) {
  return angularDistanceDeg(lonDeg, latDeg, subLon, subLat) > 90 + twilightDeg;
}

/**
 * Build the canvas-order RGBA buffer (360 x 181) from a parsed grid.
 * Canvas x 0..359 maps to lon -180..179; canvas y 0..180 maps to lat 90..-90.
 * Night side renders at full intensity; the day side is dimmed to `dayDim`
 * (aurora is invisible in daylight, but keeping a ghost shows data extent).
 * Returns `{ width, height, data }` with a Uint8ClampedArray.
 */
export function ovationImageBuffer(
  parsed,
  { subLon, subLat, dayDim = 0.08, maxRef = OVATION_RAMP_MAX } = {},
) {
  if (!parsed?.values) throw new TypeError('ovationImageBuffer needs a parsed OVATION grid');
  const width = OVATION_GRID_LONS;
  const height = OVATION_GRID_LATS;
  const data = new Uint8ClampedArray(width * height * 4);
  const haveSun = Number.isFinite(subLon) && Number.isFinite(subLat);
  for (let y = 0; y < height; y++) {
    const lat = 90 - y;
    const latIdx = lat + 90;
    for (let x = 0; x < width; x++) {
      const lon = x - 180; // canvas x -> geographic lon
      const ovLonIdx = (x + 180) % 360; // geographic lon -> OVATION lon index
      const value = parsed.values[latIdx * width + ovLonIdx];
      const [r, g, b, a] = ovationRgba(value, maxRef);
      const night = !haveSun || isNight(lon, lat, subLon, subLat);
      const dim = night ? 1 : dayDim;
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = Math.round(a * dim);
    }
  }
  return { width, height, data };
}

/** Legend stops for the HUD legend: intensity label + CSS color. */
export function ovationLegendStops(maxRef = OVATION_RAMP_MAX) {
  const samples = [1, 8, 15, 22, maxRef];
  return samples.map((v) => {
    const [r, g, b, a] = ovationRgba(v, maxRef);
    return {
      value: v,
      label: v >= maxRef ? `${maxRef}+` : String(v),
      css: `rgba(${r},${g},${b},${(a / 255).toFixed(2)})`,
    };
  });
}
