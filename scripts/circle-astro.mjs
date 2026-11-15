// Astronomy math for the Inner Circle Daily Wire.
// Standard published algorithms (SunCalc-style solar/lunar math and the
// JPL approximate Keplerian elements table, valid 1800 AD–2050 AD).
// Everything here is COMPUTED at build time and labeled as such.
const rad = Math.PI / 180;
const dayMs = 86400000;
const J1970 = 2440588, J2000 = 2451545;
const e = rad * 23.4397; // obliquity

const toJulian = (date) => date.valueOf() / dayMs - 0.5 + J1970;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * dayMs);
const toDays = (date) => toJulian(date) - J2000;

function rightAscension(l, b) { return Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l)); }
function declination(l, b) { return Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l)); }
function azimuth(H, phi, dec) { return Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)); }
function siderealTime(d, lw) { return rad * (280.16 + 360.9856235 * d) - lw; }
function solarMeanAnomaly(d) { return rad * (357.5291 + 0.98560028 * d); }
function eclipticLongitude(M) {
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = rad * 102.9372;
  return M + C + P + Math.PI;
}
function sunCoords(d) {
  const M = solarMeanAnomaly(d), L = eclipticLongitude(M);
  return { dec: declination(L, 0), ra: rightAscension(L, 0), lon: ((L / rad) % 360 + 360) % 360 };
}
function moonCoords(d) {
  const L = rad * (218.316 + 13.176396 * d);
  const M = rad * (134.963 + 13.064993 * d);
  const F = rad * (93.272 + 13.229350 * d);
  const l = L + rad * 6.289 * Math.sin(M);
  const b = rad * 5.128 * Math.sin(F);
  const dt = 385001 - 20905 * Math.cos(M);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt, lon: ((l / rad) % 360 + 360) % 360 };
}
function altitudeOf(ra, dec, date, lat, lon) {
  const lw = rad * -lon, phi = rad * lat;
  const H = siderealTime(toDays(date), lw) - ra;
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
}

// ---------- sun times ----------
const J0 = 0.0009;
const julianCycle = (d, lw) => Math.round(d - J0 - lw / (2 * Math.PI));
const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
const hourAngle = (h, phi, dec) => Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
function getSetJ(h, lw, phi, dec, n, M, L) {
  const w = hourAngle(h, phi, dec);
  const a = approxTransit(w, lw, n);
  return solarTransitJ(a, M, L);
}
export function sunTimes(date, lat, lon) {
  const lw = rad * -lon, phi = rad * lat;
  const d = toDays(date), n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds), L = eclipticLongitude(M);
  const dec = declination(L, 0);
  const Jnoon = solarTransitJ(ds, M, L);
  const Jset = getSetJ(-0.833 * rad, lw, phi, dec, n, M, L);
  const Jrise = Jnoon - (Jset - Jnoon);
  return { sunrise: fromJulian(Jrise), solarNoon: fromJulian(Jnoon), sunset: fromJulian(Jset) };
}
export function sunAltitude(date, lat, lon) {
  const c = sunCoords(toDays(date));
  return altitudeOf(c.ra, c.dec, date, lat, lon) / rad;
}

// ---------- moon ----------
export function moonIllumination(date) {
  const d = toDays(date);
  const s = sunCoords(d), m = moonCoords(d);
  const sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const illum = (1 - Math.cos(phi)) / 2; // phi = elongation; 0 at new, PI at full
  let cycle = ((m.lon - s.lon) % 360 + 360) % 360 / 360; // 0 new, 0.5 full
  return { fraction: illum, cycle, moonLon: m.lon, sunLon: s.lon };
}
const PHASE_NAMES = [
  [0.033, 'New Moon'], [0.217, 'Waxing Crescent'], [0.283, 'First Quarter'],
  [0.467, 'Waxing Gibbous'], [0.533, 'Full Moon'], [0.717, 'Waning Gibbous'],
  [0.783, 'Last Quarter'], [0.967, 'Waning Crescent'], [1.001, 'New Moon'],
];
export function phaseName(cycle) {
  for (const [limit, name] of PHASE_NAMES) if (cycle < limit) return name;
  return 'New Moon';
}
const SIGNS = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
export const signOf = (lonDeg) => SIGNS[Math.floor(((lonDeg % 360) + 360) % 360 / 30)];

export function moonTimes(date, lat, lon) {
  const t = new Date(date); t.setUTCHours(0, 0, 0, 0);
  const hc = 0.133 * rad;
  const altAt = (dt) => {
    const c = moonCoords(toDays(dt));
    return altitudeOf(c.ra, c.dec, dt, lat, lon) - hc;
  };
  let h0 = altAt(t), rise = null, set = null;
  for (let i = 1; i <= 24; i += 2) {
    const h1 = altAt(new Date(t.getTime() + i * 3600000));
    const h2 = altAt(new Date(t.getTime() + (i + 1) * 3600000));
    const a = (h0 + h2) / 2 - h1, b = (h2 - h0) / 2;
    const xe = -b / (2 * a), ye = (a * xe + b) * xe + h1;
    const d = b * b - 4 * a * h1;
    let roots = 0, x1 = null, x2 = null;
    if (d >= 0) {
      const dx = Math.sqrt(d) / (Math.abs(a) * 2);
      x1 = xe - dx; x2 = xe + dx;
      if (Math.abs(x1) <= 1) roots++;
      if (Math.abs(x2) <= 1) { if (x1 < -1) x1 = x2; roots++; }
    }
    if (roots === 1) { if (h0 < 0) rise = i + x1; else set = i + x1; }
    else if (roots === 2) { rise = i + (ye < 0 ? x2 : x1); set = i + (ye < 0 ? x1 : x2); }
    if (rise !== null && set !== null) break;
    h0 = h2;
  }
  const out = {};
  if (rise !== null) out.rise = new Date(t.getTime() + rise * 3600000);
  if (set !== null) out.set = new Date(t.getTime() + set * 3600000);
  return out;
}

// next moon sign change (for void-of-course window display)
export function nextMoonSignChange(from) {
  const startSign = signOf(moonCoords(toDays(from)).lon);
  for (let h = 1; h <= 72; h += 1) {
    const t = new Date(from.getTime() + h * 3600000);
    const s = signOf(moonCoords(toDays(t)).lon);
    if (s !== startSign) return { sign: s, at: t };
  }
  return null;
}

// ---------- planets (JPL approximate Keplerian elements, 1800–2050) ----------
const ELEMENTS = {
  Mercury: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593, 0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  Venus: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255, 0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
  Earth: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0, 0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  Mars: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  Jupiter: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  Saturn: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  Uranus: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503, -0.00196176, -0.00004397, -0.00242939, 142.59011169, 0.40805281, 0.04240589],
  Neptune: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 0.00026291, 0.00005105, 0.00035372, 256.44976757, -0.32241464, -0.00508664],
  Pluto: [39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684, -0.00031596, 0.00005170, 0.00004818, 145.20780515, -0.04062942, -0.01183482],
};
function helio(name, date) {
  const T = toDays(date) / 36525;
  const el = ELEMENTS[name];
  const a = el[0] + el[6] * T, ecc = el[1] + el[7] * T, I = rad * (el[2] + el[8] * T);
  const L = rad * (el[3] + el[9] * T), p = rad * (el[4] + el[10] * T), O = rad * (el[5] + el[11] * T);
  const w = p - O;
  let M = (L - p) % (2 * Math.PI); if (M > Math.PI) M -= 2 * Math.PI; if (M < -Math.PI) M += 2 * Math.PI;
  let E = M + ecc * Math.sin(M);
  for (let i = 0; i < 8; i++) E = E - (E - ecc * Math.sin(E) - M) / (1 - ecc * Math.cos(E));
  const xp = a * (Math.cos(E) - ecc), yp = a * Math.sqrt(1 - ecc * ecc) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
  return {
    x: (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    y: (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    z: (sw * sI) * xp + (cw * sI) * yp,
  };
}
export function geoPlanet(name, date) {
  const p = helio(name, date), ePos = helio('Earth', date);
  const x = p.x - ePos.x, y = p.y - ePos.y, z = p.z - ePos.z;
  const lon = ((Math.atan2(y, x) / rad) % 360 + 360) % 360;
  const latEcl = Math.atan2(z, Math.hypot(x, y));
  const ra = rightAscension(lon * rad, latEcl);
  const dec = declination(lon * rad, latEcl);
  return { lon, ra, dec, distAU: Math.hypot(x, y, z) };
}
export function planetAltitude(name, date, lat, lon) {
  const g = geoPlanet(name, date);
  return altitudeOf(g.ra, g.dec, date, lat, lon) / rad;
}

// ---------- extra exports for the full registry ----------
export function sunEvents(date, lat, lon) {
  const lw = rad * -lon, phi = rad * lat;
  const d = toDays(date), n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds), L = eclipticLongitude(M);
  const dec = declination(L, 0);
  const Jnoon = solarTransitJ(ds, M, L);
  const out = { solarNoon: fromJulian(Jnoon) };
  for (const [key, h] of [['sun', -0.833], ['civil', -6], ['nautical', -12], ['astro', -18]]) {
    try {
      const Jset = getSetJ(h * rad, lw, phi, dec, n, M, L);
      out[key + 'Set'] = fromJulian(Jset);
      out[key + 'Rise'] = fromJulian(Jnoon - (Jset - Jnoon));
    } catch { out[key + 'Set'] = null; out[key + 'Rise'] = null; }
  }
  return out;
}
export function moonAltitude(date, lat, lon) {
  const c = moonCoords(toDays(date));
  return altitudeOf(c.ra, c.dec, date, lat, lon) / rad;
}
export function moonDistanceKm(date) { return Math.round(moonCoords(toDays(date)).dist); }
export function altitudeForRaDec(raHours, decDeg, date, lat, lon) {
  return altitudeOf(raHours * 15 * rad, decDeg * rad, date, lat, lon) / rad;
}
export { moonCoords, sunCoords };

// ---------- TLE two-body propagation (ISS) ----------
// Simplified Keplerian propagation from a fresh TLE: good to a few km
// over the first day — labeled approximate wherever it is shown.
export function parseTLE(line1, line2) {
  const epochYear = Number(line1.slice(18, 20));
  const epochDay = Number(line1.slice(20, 32));
  const fullYear = epochYear < 57 ? 2000 + epochYear : 1900 + epochYear;
  const epochMs = Date.UTC(fullYear, 0, 1) + (epochDay - 1) * 86400000;
  return {
    epochMs,
    inc: rad * Number(line2.slice(8, 16)),
    raan: rad * Number(line2.slice(17, 25)),
    ecc: Number('0.' + line2.slice(26, 33).trim()),
    argp: rad * Number(line2.slice(34, 42)),
    M0: rad * Number(line2.slice(43, 51)),
    meanMotion: Number(line2.slice(52, 63)), // rev/day
  };
}
export function propagateTLE(tle, date) {
  const mu = 398600.4418;
  const n = tle.meanMotion * 2 * Math.PI / 86400; // rad/s
  const a = Math.cbrt(mu / (n * n));
  const dt = (date.getTime() - tle.epochMs) / 1000;
  let M = (tle.M0 + n * dt) % (2 * Math.PI); if (M < 0) M += 2 * Math.PI;
  let E = M + tle.ecc * Math.sin(M);
  for (let i = 0; i < 8; i++) E = E - (E - tle.ecc * Math.sin(E) - M) / (1 - tle.ecc * Math.cos(E));
  const nu = 2 * Math.atan2(Math.sqrt(1 + tle.ecc) * Math.sin(E / 2), Math.sqrt(1 - tle.ecc) * Math.cos(E / 2));
  const r = a * (1 - tle.ecc * Math.cos(E));
  const xp = r * Math.cos(nu), yp = r * Math.sin(nu);
  const cw = Math.cos(tle.argp), sw = Math.sin(tle.argp), cO = Math.cos(tle.raan), sO = Math.sin(tle.raan), cI = Math.cos(tle.inc), sI = Math.sin(tle.inc);
  const x = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
  const y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
  const z = (sw * sI) * xp + (cw * sI) * yp;
  const jd = date.valueOf() / 86400000 + 2440587.5;
  let gmst = (280.46061837 + 360.98564736629 * (jd - 2451545)) % 360; if (gmst < 0) gmst += 360;
  const lon = ((Math.atan2(y, x) / rad - gmst + 540) % 360) - 180;
  const lat = Math.atan2(z, Math.hypot(x, y)) / rad;
  return { lat, lon, altKm: Math.hypot(x, y, z) - 6371 };
}

// ---------- ISS geometry ----------
export function issElevation(issLat, issLon, issAltKm, lat, lon) {
  const R = 6371;
  const p1 = rad * lat, p2 = rad * issLat, dl = rad * (issLon - lon);
  const cosC = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  const c = Math.acos(Math.max(-1, Math.min(1, cosC))); // central angle
  const r = R + issAltKm;
  const range = Math.sqrt(R * R + r * r - 2 * R * r * Math.cos(c));
  const sinEl = (r * Math.cos(c) - R) / range;
  return Math.asin(Math.max(-1, Math.min(1, sinEl))) / rad;
}
