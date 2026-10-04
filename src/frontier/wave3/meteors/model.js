/**
 * Wave 3 Track 2c / 2.14 — meteor night-side display model.
 *
 * subsolarPoint(dateMs): approximate subsolar longitude/latitude (solar
 * declination + equation-of-time approximation, NOAA-style, ±0.5° — display
 * grade only). isNightSide(lon, lat, dateMs): true when the point's solar
 * zenith angle > 90° (below the horizon), i.e. the meteor's midpoint was in
 * darkness at event time. filterNightSide keeps the dark-hemisphere events.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Approximate subsolar point { lon, lat } in degrees. Pure; testable. */
export function subsolarPoint(dateMs) {
  const d = new Date(dateMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((dateMs - start) / 86400000);
  const utcHours =
    d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;

  // Fractional year (radians) — NOAA solar-position approximation.
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (utcHours - 12) / 24);
  const eqtime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  const timeOffset = eqtime; // minutes (longitude 0)
  const tst = utcHours * 60 + timeOffset;
  let ha = tst / 4 - 180; // hour angle, degrees
  const lat = decl * DEG;
  let lon = -ha;
  lon = ((lon + 540) % 360) - 180;
  return { lon, lat };
}

/** Solar zenith angle in degrees for (lon, lat) at dateMs. */
export function solarZenithDeg(lon, lat, dateMs) {
  const sun = subsolarPoint(dateMs);
  const cosZ =
    Math.sin(lat * RAD) * Math.sin(sun.lat * RAD) +
    Math.cos(lat * RAD) *
      Math.cos(sun.lat * RAD) *
      Math.cos((lon - sun.lon) * RAD);
  return Math.acos(Math.max(-1, Math.min(1, cosZ))) * DEG;
}

export function isNightSide(lon, lat, dateMs) {
  return solarZenithDeg(lon, lat, dateMs) > 90;
}

/** Keep events whose begin/end midpoint was on the night side. */
export function filterNightSide(meteors, cap = 300) {
  const out = [];
  for (const m of meteors ?? []) {
    if (out.length >= cap) break;
    const midLon = (m.lonBeg + m.lonEnd) / 2;
    const midLat = (m.latBeg + m.latEnd) / 2;
    if (isNightSide(midLon, midLat, m.timeMs)) out.push(m);
  }
  return out;
}

/** Streak length in degrees (display sizing). */
export function streakDeg(m) {
  const dLon =
    (m.lonEnd - m.lonBeg) * Math.cos(((m.latBeg + m.latEnd) / 2) * RAD);
  const dLat = m.latEnd - m.latBeg;
  return Math.sqrt(dLon * dLon + dLat * dLat);
}
