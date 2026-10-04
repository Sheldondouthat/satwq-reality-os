/**
 * Terminator Rush — pure solar-position math (NOAA SPA low-precision series).
 *
 * No API, no keys, client-side only. Computes the subsolar point and the
 * civil-twilight terminator band (solar elevation −6° ± 2°, "sunset
 * happening NOW") for any instant.
 *
 * Accuracy: the NOAA series used here is good to ~0.01° for declination —
 * far tighter than a 2° band needs. All outputs are labeled COMPUTED.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const TERMINATOR_CENTER_ELEV = -6;
export const TERMINATOR_HALF_WIDTH = 2;

/** Julian day number (UTC). */
export function julianDay(date) {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

function gammaOf(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000);
  const hour =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600;
  return ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hour - 12) / 24);
}

/** Solar declination, radians (NOAA series). */
export function solarDeclination(date) {
  const g = gammaOf(date);
  return (
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g)
  );
}

/** Equation of time, minutes (NOAA series). */
export function equationOfTime(date) {
  const g = gammaOf(date);
  return (
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g))
  );
}

/** Subsolar point {lat, lon} in degrees for the given instant (COMPUTED). */
export function subsolarPoint(date) {
  const decl = solarDeclination(date) * RAD;
  const utcMinutes =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  // Hour angle HA = (utcMinutes + eqtime)/4 + lon − 180; solar noon ⇒ HA = 0.
  let lon = 180 - (utcMinutes + equationOfTime(date)) / 4;
  lon = ((lon + 540) % 360) - 180;
  return { lat: decl, lon };
}

/** Solar elevation angle in degrees at (lat, lon) for the given instant. */
export function solarElevation(latDeg, lonDeg, date) {
  const decl = solarDeclination(date);
  const utcMinutes =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const haDeg = (utcMinutes + equationOfTime(date)) / 4 + lonDeg - 180;
  const ha = ((haDeg + 180) % 360) - 180;
  const lat = latDeg * DEG;
  const sinE =
    Math.sin(lat) * Math.sin(decl) +
    Math.cos(lat) * Math.cos(decl) * Math.cos(ha * DEG);
  return Math.asin(Math.max(-1, Math.min(1, sinE))) * RAD;
}

function refineCrossing(lon, target, latA, latB, date) {
  let a = latA;
  let b = latB;
  let fa = solarElevation(a, lon, date) - target;
  for (let i = 0; i < 24; i += 1) {
    const mid = (a + b) / 2;
    const fm = solarElevation(mid, lon, date) - target;
    if (fa * fm <= 0) {
      b = mid;
    } else {
      a = mid;
      fa = fm;
    }
  }
  return (a + b) / 2;
}

/**
 * Points [{lon, lat}] where the solar elevation equals targetElev, ordered
 * into the closed twilight loop.
 *
 * Geometry note: the −6° line is a small circle of angular radius 96°
 * around the subsolar point (equivalently 84° around the ANTISOLAR point),
 * so it spans only ~168° of longitude — it is a closed loop around the
 * night side, not a full ring around the globe. Each in-span meridian
 * crosses it twice, so we collect every crossing and order the set by
 * polar angle around the antisolar point. Bisection-refined to ~0.01°.
 */
export function terminatorLine(
  date,
  targetElev = TERMINATOR_CENTER_ELEV,
  steps = 180,
) {
  const antisolar = {
    lat: -subsolarPoint(date).lat,
    lon: subsolarPoint(date).lon + 180,
  };
  const crossings = [];
  const sampleStep = 0.5;
  for (let i = 0; i < steps; i += 1) {
    const lon = -180 + (360 * i) / steps;
    let prevLat = -89;
    let prevVal = solarElevation(prevLat, lon, date) - targetElev;
    for (let lat = -89 + sampleStep; lat <= 89; lat += sampleStep) {
      const val = solarElevation(lat, lon, date) - targetElev;
      if (prevVal === 0) {
        crossings.push({ lon, lat: prevLat });
      } else if (val * prevVal < 0) {
        crossings.push({
          lon,
          lat: refineCrossing(lon, targetElev, prevLat, lat, date),
        });
      }
      prevLat = lat;
      prevVal = val;
    }
  }
  // Order into a closed loop by polar angle around the antisolar point.
  const toRad = Math.PI / 180;
  const aLat = antisolar.lat * toRad;
  const aLon = (((antisolar.lon + 540) % 360) - 180) * toRad;
  const angled = crossings.map((p) => {
    const pLat = p.lat * toRad;
    const pLon = p.lon * toRad;
    const dLon = pLon - aLon;
    // Initial bearing from antisolar point to p.
    const y = Math.sin(dLon) * Math.cos(pLat);
    const x =
      Math.cos(aLat) * Math.sin(pLat) -
      Math.sin(aLat) * Math.cos(pLat) * Math.cos(dLon);
    return { ...p, angle: Math.atan2(y, x) };
  });
  angled.sort((p, q) => p.angle - q.angle);
  return angled.map(({ lon, lat }) => ({ lon, lat }));
}

/** True when elevation lies within center ± half degrees. */
export function onTerminatorBand(
  elevationDeg,
  center = TERMINATOR_CENTER_ELEV,
  half = TERMINATOR_HALF_WIDTH,
) {
  return Math.abs(elevationDeg - center) <= half;
}

/** {elevation, onBand} for a point at an instant. */
export function bandMembership(
  lat,
  lon,
  date,
  center = TERMINATOR_CENTER_ELEV,
  half = TERMINATOR_HALF_WIDTH,
) {
  const elevation = solarElevation(lat, lon, date);
  return { elevation, onBand: onTerminatorBand(elevation, center, half) };
}
