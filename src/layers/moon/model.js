/**
 * Low-precision lunar ephemeris (simplified Meeus/Schlyter algorithm).
 * Pure math — no network, no Cesium. Position accuracy ~0.1-0.3°,
 * illumination within a few percent; ample for a display layer.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const norm360 = (x) => ((x % 360) + 360) % 360;
const norm180 = (lon) => ((lon + 540) % 360) - 180;

/** Days since 2000 Jan 0.0 (JD 2451543.5) for a Date. */
function dayNumber(date) {
  return (date.getTime() - Date.UTC(1999, 11, 31, 0, 0, 0)) / 86400000;
}

function gmstDeg(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  return norm360(280.46061837 + 360.98564736629 * (jd - 2451545));
}

function eccentricAnomaly(Mdeg, e) {
  let E = Mdeg + DEG * e * Math.sin(Mdeg * RAD) * (1 + e * Math.cos(Mdeg * RAD));
  for (let k = 0; k < 10; k++) {
    const next =
      E - (E - DEG * e * Math.sin(E * RAD) - Mdeg) / (1 - e * Math.cos(E * RAD));
    if (Math.abs(next - E) < 1e-4) return next;
    E = next;
  }
  return E;
}

/** Sun's geocentric ecliptic longitude/latitude and mean anomaly. */
function sunEcliptic(d) {
  const w = 282.9404 + 4.70935e-5 * d;
  const e = 0.016709 - 1.151e-9 * d;
  const M = norm360(356.047 + 0.9856002585 * d);
  const E = eccentricAnomaly(M, e);
  const xv = Math.cos(E * RAD) - e;
  const yv = Math.sqrt(1 - e * e) * Math.sin(E * RAD);
  const v = Math.atan2(yv, xv) * DEG;
  const xh = Math.sqrt(xv * xv + yv * yv) * Math.cos((v + w) * RAD);
  const yh = Math.sqrt(xv * xv + yv * yv) * Math.sin((v + w) * RAD);
  return { lon: norm360(Math.atan2(yh, xh) * DEG), M, w };
}

/** Moon's geocentric ecliptic longitude/latitude with major perturbations. */
function moonEcliptic(d, Ms, ws) {
  const N = norm360(125.1228 - 0.0529538083 * d);
  const i = 5.1454;
  const w = norm360(318.0634 + 0.1643573223 * d);
  const a = 60.2666;
  const e = 0.0549;
  const M = norm360(115.3654 + 13.0649929509 * d);
  const E = eccentricAnomaly(M, e);
  const xv = a * (Math.cos(E * RAD) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E * RAD);
  const v = Math.atan2(yv, xv) * DEG;
  const r = Math.sqrt(xv * xv + yv * yv);
  const vw = (v + w) * RAD;
  const Nr = N * RAD;
  const ir = i * RAD;
  const xh =
    r * (Math.cos(Nr) * Math.cos(vw) - Math.sin(Nr) * Math.sin(vw) * Math.cos(ir));
  const yh =
    r * (Math.sin(Nr) * Math.cos(vw) + Math.cos(Nr) * Math.sin(vw) * Math.cos(ir));
  const zh = r * Math.sin(vw) * Math.sin(ir);
  let lon = norm360(Math.atan2(yh, xh) * DEG);
  let lat = Math.atan2(zh, Math.sqrt(xh * xh + yh * yh)) * DEG;

  // Major perturbation terms (degrees).
  const Lm = norm360(N + w + M);
  const Dm = norm360(Lm - (ws + Ms));
  const Fm = norm360(Lm - N);
  const s = (x) => Math.sin(x * RAD);
  lon +=
    -1.274 * s(M - 2 * Dm) +
    0.658 * s(2 * Dm) -
    0.186 * s(Ms) -
    0.059 * s(2 * M - 2 * Dm) -
    0.057 * s(M - 2 * Dm + Ms);
  lat +=
    -0.173 * s(Fm - 2 * Dm) -
    0.055 * s(M - Fm - 2 * Dm) -
    0.046 * s(M + Fm - 2 * Dm) +
    0.033 * s(Fm + 2 * Dm) +
    0.017 * s(2 * M + Fm);
  return { lon: norm360(lon), lat };
}

function eclipticToRaDec(lon, lat, d) {
  const ecl = 23.4393 - 3.563e-7 * d;
  const lr = lon * RAD;
  const br = lat * RAD;
  const er = ecl * RAD;
  const x = Math.cos(lr) * Math.cos(br);
  const y = Math.sin(lr) * Math.cos(br) * Math.cos(er) - Math.sin(br) * Math.sin(er);
  const z = Math.sin(lr) * Math.cos(br) * Math.sin(er) + Math.sin(br) * Math.cos(er);
  return {
    ra: norm360(Math.atan2(y, x) * DEG),
    dec: Math.atan2(z, Math.sqrt(x * x + y * y)) * DEG,
  };
}

function sunMoon(date) {
  const d = dayNumber(date);
  const sun = sunEcliptic(d);
  const moon = moonEcliptic(d, sun.M, sun.w);
  return { d, sun, moon };
}

/** Sub-lunar surface point for a Date: { lat, lon } in degrees. */
export function moonPosition(date) {
  const { d, moon } = sunMoon(date);
  const { ra, dec } = eclipticToRaDec(moon.lon, moon.lat, d);
  return { lat: dec, lon: norm180(ra - gmstDeg(date)) };
}

/**
 * Lunar phase for a Date.
 * Returns { illumination (0..1), elongationDeg, waxing, name }.
 * Illumination derives from the geocentric sun-moon elongation.
 */
export function moonPhase(date) {
  const { d, sun, moon } = sunMoon(date);
  const sEq = eclipticToRaDec(sun.lon, 0, d);
  const mEq = eclipticToRaDec(moon.lon, moon.lat, d);
  const cosEl =
    Math.sin(sEq.dec * RAD) * Math.sin(mEq.dec * RAD) +
    Math.cos(sEq.dec * RAD) *
      Math.cos(mEq.dec * RAD) *
      Math.cos((mEq.ra - sEq.ra) * RAD);
  const elong = Math.acos(Math.min(1, Math.max(-1, cosEl))) * DEG;
  const illumination = (1 - Math.cos(elong * RAD)) / 2;
  const waxing = norm180(moon.lon - sun.lon) > 0;
  let name;
  if (elong < 22.5) name = 'New Moon';
  else if (elong < 67.5) name = waxing ? 'Waxing Crescent' : 'Waning Crescent';
  else if (elong < 112.5) name = waxing ? 'First Quarter' : 'Last Quarter';
  else if (elong < 157.5) name = waxing ? 'Waxing Gibbous' : 'Waning Gibbous';
  else name = 'Full Moon';
  return { illumination, elongationDeg: elong, waxing, name };
}

/** Fraction of the lunar disk illuminated (0..1). */
export function moonIllumination(date) {
  return moonPhase(date).illumination;
}
