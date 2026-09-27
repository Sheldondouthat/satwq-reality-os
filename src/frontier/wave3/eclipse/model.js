/**
 * Wave 3 / Track 3b — eclipse geometry engine (pure, Cesium-free, node-testable).
 *
 * Implements the standard Besselian-elements method for solar eclipses.
 * Event data below is reproduced from NASA GSFC / Fred Espenak,
 * "Besselian Elements - Total Solar Eclipse of 2045 August 12"
 * (Five Millennium Canon of Solar Eclipses), retrieved 2026-09-27:
 *   http://eclipse.gsfc.nasa.gov/SEsearch/SEdata.php?Ecl=20450812
 * "Eclipse Predictions by Fred Espenak, NASA's GSFC"
 *
 * Conventions (validated against the greatest-eclipse anchor in tests):
 *   - t: decimal hours from t0, in TDT (Terrestrial Dynamical Time).
 *   - Fundamental plane: origin at Earth's center, z-axis toward the Sun.
 *     x-axis lies in the equatorial plane; y-axis completes right-handed
 *     system with +y pointing north-ish in the fundamental plane.
 *   - Earth-fixed frame: X -> (lat 0, lon 0), Y -> (lat 0, lon 90E), Z -> north.
 *     Subsolar longitude = -mu (degrees, east positive).
 */

export const EARTH_RADIUS_KM = 6378.0;

/**
 * Embedded Besselian elements: TOTAL SOLAR ECLIPSE 2045 AUG 12.
 * t0 = 18.000 TDT. a = a0 + a1*t + a2*t^2 + a3*t^3.
 * Source: NASA GSFC SEdata.php?Ecl=20450812 (see header).
 */
export const ECLIPSE_2045 = {
  name: 'Total solar eclipse of 2045 August 12',
  saros: 136,
  t0TdtHours: 18.0,
  deltaTSec: 89.1,
  tanF1: 0.0046137, // penumbral cone
  tanF2: 0.0045908, // umbral cone
  // [a0, a1, a2, a3]
  x: [0.2406600, 0.5332199, -0.0000535, -0.0000090],
  y: [0.1240940, -0.2388144, -0.0000966, 0.0000042],
  d: [14.6739397, -0.0121070, -0.0000030, 0],
  l1: [0.5309430, -0.0000029, -0.0000129, 0],
  l2: [-0.0151190, -0.0000029, -0.0000128, 0],
  mu: [88.760483, 15.003170, 0, 0],
  // Anchors for validation (greatest eclipse):
  greatestEclipseUtc: '2045-08-12T17:41:10Z',
  greatestLat: 25.9,
  greatestLon: -78.5,
  pathWidthKm: 255.6,
  centralDurationSec: 366,
};

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function poly(c, t) {
  return c[0] + c[1] * t + c[2] * t * t + c[3] * t * t * t;
}

/** Evaluate all elements at t (decimal hours from t0, TDT). */
export function evalElements(ev, t) {
  return {
    x: poly(ev.x, t),
    y: poly(ev.y, t),
    d: poly(ev.d, t) * D2R,
    l1: poly(ev.l1, t),
    l2: poly(ev.l2, t),
    mu: poly(ev.mu, t) * D2R,
    t,
  };
}

/** TDT decimal hours -> Date (UTC), using the event's ΔT. */
export function tdtHoursToUtc(ev, t) {
  const tdtMs = Date.UTC(2045, 7, 12, 0, 0, 0) + (ev.t0TdtHours + t) * 3600000;
  return new Date(tdtMs - ev.deltaTSec * 1000);
}

/**
 * Sub-shadow point (where the shadow axis meets Earth's surface) at time t.
 * Returns { latDeg, lonDeg } or null when the axis misses Earth.
 */
export function subShadowPoint(ev, t) {
  const e = evalElements(ev, t);
  const { x, y, d, mu } = e;
  // Sun direction in Earth-fixed frame (subsolar lon = -mu, east positive).
  const cosD = Math.cos(d);
  const sx = cosD * Math.cos(mu);
  const sy = -cosD * Math.sin(mu);
  const sz = Math.sin(d);
  // Fundamental-plane basis: yN = north-ish component of Z perp to sun dir.
  const dot = sz; // Z_hat . s_hat
  let yx = -dot * sx;
  let yy = -dot * sy;
  let yz = 1 - dot * sz;
  const yn = Math.hypot(yx, yy, yz);
  if (yn < 1e-12) return null;
  yx /= yn; yy /= yn; yz /= yn;
  // xF = yN x s (right-handed: xF x yN = s).
  const xx = yy * sz - yz * sy;
  const xy = yz * sx - yx * sz;
  const xz = yx * sy - yy * sx;
  // Point where the axis pierces the fundamental plane (Earth radii).
  const px = x * xx + y * yx;
  const py = x * xy + y * yy;
  const pz = x * xz + y * yz;
  // Intersect ray P + s*s_hat with the unit sphere; take the sunward hit.
  const pDotS = px * sx + py * sy + pz * sz; // == 0 by construction; keep general
  const p2 = px * px + py * py + pz * pz;
  const disc = pDotS * pDotS - (p2 - 1);
  if (disc < 0) return null;
  const s = -pDotS + Math.sqrt(disc); // sunward intersection (s > 0)
  const qx = px + s * sx;
  const qy = py + s * sy;
  const qz = pz + s * sz;
  const qn = Math.hypot(qx, qy, qz);
  const lat = Math.asin(Math.max(-1, Math.min(1, qz / qn))) * R2D;
  let lon = Math.atan2(qy, qx) * R2D;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { latDeg: lat, lonDeg: lon, q: [qx / qn, qy / qn, qz / qn], sHit: s, p2 };
}

/**
 * Umbral shadow ellipse on the surface at time t.
 * Returns null when the axis misses Earth or the eclipse is not total there.
 * { center:{lat,lon}, semiMinorKm, semiMajorKm, majorAxisBearingDeg,
 *   sunAltitudeDeg, centralDurationSec (estimated) }
 *
 * Geometry: umbral cone radius grows toward the Moon at tan(f2) per unit
 * distance from the fundamental plane; the surface hit is sHit Earth-radii
 * sunward of the plane. The ground ellipse minor axis = 2r; the major axis
 * is stretched by 1/cos(zenith) along the sunward bearing.
 */
export function umbralEllipse(ev, t) {
  const sub = subShadowPoint(ev, t);
  if (!sub) return null;
  const e = evalElements(ev, t);
  if (e.l2 >= 0) return null; // not an umbral (total) shadow here
  const rFund = Math.abs(e.l2) + ev.tanF2 * sub.sHit; // Earth radii
  const rKm = rFund * EARTH_RADIUS_KM;
  // Sun direction at the sub-shadow point -> altitude.
  const cosD = Math.cos(e.d);
  const sx = cosD * Math.cos(e.mu);
  const sy = -cosD * Math.sin(e.mu);
  const sz = Math.sin(e.d);
  const cosZen = Math.max(0.05,
    sx * sub.q[0] + sy * sub.q[1] + sz * sub.q[2]);
  const zenDeg = Math.acos(Math.min(1, cosZen)) * R2D;
  const semiMinorKm = rKm;
  const semiMajorKm = rKm / cosZen;
  // Bearing of the major axis: surface direction toward the subsolar point.
  const latR = sub.latDeg * D2R;
  const lonR = sub.lonDeg * D2R;
  // Subsolar point:
  const subLatR = e.d;
  let subLonR = -e.mu;
  // Initial bearing from sub-shadow point to subsolar point.
  const dLon = subLonR - lonR;
  const brg = Math.atan2(
    Math.sin(dLon) * Math.cos(subLatR),
    Math.cos(latR) * Math.sin(subLatR) - Math.sin(latR) * Math.cos(subLatR) * Math.cos(dLon),
  ) * R2D;
  return {
    center: { latDeg: sub.latDeg, lonDeg: sub.lonDeg },
    semiMinorKm,
    semiMajorKm,
    majorAxisBearingDeg: (brg + 360) % 360,
    sunAltitudeDeg: 90 - zenDeg,
    widthKm: 2 * semiMinorKm,
    utc: tdtHoursToUtc(ev, t).toISOString(),
    t,
  };
}

/**
 * Shadow ground speed (km/s) at time t, by finite difference of the
 * sub-shadow point. Used to estimate central duration.
 */
export function shadowSpeedKms(ev, t, dtH = 0.005) {
  const a = subShadowPoint(ev, t - dtH);
  const b = subShadowPoint(ev, t + dtH);
  if (!a || !b) return null;
  const dtS = 2 * dtH * 3600;
  const toCart = (p) => {
    const la = p.latDeg * D2R;
    const lo = p.lonDeg * D2R;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  };
  const ca = toCart(a);
  const cb = toCart(b);
  const chord = Math.hypot(cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]);
  const ang = 2 * Math.asin(Math.min(1, chord / 2));
  return (ang * EARTH_RADIUS_KM) / dtS;
}

/**
 * Sample the event: centerline + umbral ellipses every stepMin minutes
 * across the window where the penumbra touches Earth.
 * Returns { samples:[{t, utc, center, ellipse, speedKms, durationSec}], ... }.
 */
export function sampleEclipse(ev, { stepMin = 5, padH = 4 } = {}) {
  // Find the window where |C| < 1 + l1 (penumbra reaches Earth).
  const step = stepMin / 60;
  let tStart = null;
  let tEnd = null;
  for (let t = -padH; t <= padH; t += step) {
    const e = evalElements(ev, t);
    if (Math.hypot(e.x, e.y) < 1 + e.l1) {
      if (tStart === null) tStart = t;
      tEnd = t;
    }
  }
  if (tStart === null) return { samples: [], tStart: null, tEnd: null };
  const samples = [];
  for (let t = tStart; t <= tEnd + 1e-9; t += step) {
    const center = subShadowPoint(ev, t);
    if (!center) continue;
    const ellipse = umbralEllipse(ev, t);
    const speed = shadowSpeedKms(ev, t);
    samples.push({
      t,
      utc: tdtHoursToUtc(ev, t).toISOString(),
      center: { latDeg: center.latDeg, lonDeg: center.lonDeg },
      ellipse,
      speedKms: speed,
      // Central duration ≈ minor-axis width / ground speed.
      durationSec:
        ellipse && speed ? (2 * ellipse.semiMinorKm) / speed : null,
    });
  }
  return { samples, tStart, tEnd };
}

/** UTC Date/ms -> TDT decimal hours from t0 (inverse of tdtHoursToUtc). */
export function utcToTdtHours(ev, utcMs) {
  const ms = utcMs instanceof Date ? utcMs.getTime() : utcMs;
  return (
    (ms + ev.deltaTSec * 1000 - Date.UTC(2045, 7, 12, 0, 0, 0)) / 3600000 -
    ev.t0TdtHours
  );
}

/**
 * Subsolar point (lat/lon) at time t, from the solar declination and
 * Greenwich hour angle in the elements. Used for golden/blue-hour rings
 * during the rehearsal.
 */
export function subsolarPointAt(ev, t) {
  const e = evalElements(ev, t);
  let lon = (-e.mu * R2D) % 360;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { latDeg: e.d * R2D, lonDeg: lon };
}

// — Golden / blue hour bands (solar elevation geometry) —

/**
 * Golden hour: sun elevation in [+6°, −4°]; blue hour: (−4°, −6°].
 * As seen from the subsolar point, these are rings at angular distance
 * 90° − elevation. Returns ring definitions for polygon-with-hole rendering.
 */
export const LIGHT_BANDS = [
  { name: 'golden hour', elevHi: 6, elevLo: -4, color: '#ffb347' },
  { name: 'blue hour', elevHi: -4, elevLo: -6, color: '#4d6fff' },
];

/** Angular radius (degrees) of the ring edges for a solar elevation. */
export function ringRadiusForElevation(elevDeg) {
  return 90 - elevDeg;
}

/**
 * Great-circle ring points around (latDeg, lonDeg) at angular radius rDeg.
 * Returns [lon, lat] pairs. Pure spherical geometry.
 */
export function ringAroundPoint(latDeg, lonDeg, rDeg, n = 128) {
  const la = latDeg * D2R;
  const lo = lonDeg * D2R;
  const r = rDeg * D2R;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const brg = (i / n) * 2 * Math.PI;
    const sinLa2 = Math.sin(la) * Math.cos(r) + Math.cos(la) * Math.sin(r) * Math.cos(brg);
    const la2 = Math.asin(Math.max(-1, Math.min(1, sinLa2)));
    const lo2 =
      lo +
      Math.atan2(
        Math.sin(brg) * Math.sin(r) * Math.cos(la),
        Math.cos(r) - Math.sin(la) * sinLa2,
      );
    let loDeg = (lo2 * R2D) % 360;
    if (loDeg > 180) loDeg -= 360;
    if (loDeg < -180) loDeg += 360;
    pts.push([loDeg, la2 * R2D]);
  }
  return pts;
}
