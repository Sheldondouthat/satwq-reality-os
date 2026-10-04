/**
 * TLE decay mathematics — Track 3a item 3.4 (shared core).
 *
 * Pure functions, zero dependencies, no DOM, no satellite.js: safe to import
 * from BOTH the server provider (Pages Functions bundle stays plain
 * fetch+JSON) and the browser model (which adds SGP4 ground tracks via
 * satellite.js separately).
 *
 * Model (labeled as a model everywhere it surfaces):
 *   - Parse TLE line 1/2 → mean motion n (rev/day), eccentricity e,
 *     first derivative ndot (rev/day²), B* drag term, epoch.
 *     NOTE (TLE convention, CelesTrak format doc): line-1 columns 34–43 store
 *     the first derivative of mean motion DIVIDED BY TWO. tleElements()
 *     doubles the field so el.ndot is the true d(mean motion)/dt.
 *   - Semi-major axis from n: a = (μ / (2πn/86400)²)^(1/3).
 *   - Perigee altitude = a(1−e) − R⊕.
 *   - "Decayed" = mean motion reaching n_crit for a 150 km circular orbit.
 *   - daysToDecay = (n_crit − n) / ndot, requiring ndot > 0.
 *   - Uncertainty envelope: ±max(0.5 d, 25% of prediction) — real reentry
 *     windows span hours to days; this is an extrapolation, not a forecast.
 */

export const MU_KM3_S2 = 398600.4418;
export const EARTH_RADIUS_KM = 6378.135;
export const DECAY_ALTITUDE_KM = 150;
export const N_CRIT_REV_DAY = (() => {
  const a = EARTH_RADIUS_KM + DECAY_ALTITUDE_KM;
  const nRadS = Math.sqrt(MU_KM3_S2 / a ** 3);
  return (nRadS * 86400) / (2 * Math.PI);
})();

/** Parse CelesTrak implied-decimal fields like " 12345-6" → 0.12345e-6. */
export function parseImpliedFloat(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = /^([+-]?)(\d{5})([+-]\d)$/.exec(s.replace(/\s+/g, ''));
  if (!m) return null;
  const mantissa = Number(`0.${m[2]}`);
  const exp = Number(m[3]);
  if (!Number.isFinite(mantissa) || !Number.isFinite(exp)) return null;
  return (m[1] === '-' ? -1 : 1) * mantissa * 10 ** exp;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Split raw GP/TLE text into 3-line sets {name, line1, line2}.
 * Tolerates missing name lines.
 */
export function parseTleText(text) {
  if (typeof text !== 'string') return [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const sets = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^1 \d{5,6}/.test(lines[i]) && /^2 \d{5,6}/.test(lines[i + 1] ?? '')) {
      const prev = lines[i - 1] ?? '';
      const name = i > 0 && !/^[12] /.test(prev) ? prev.trim() : '';
      sets.push({ name, line1: lines[i], line2: lines[i + 1] });
    }
  }
  return sets;
}

/** Extract orbital elements from a TLE pair. Null on garbage. */
export function tleElements(line1, line2) {
  if (typeof line1 !== 'string' || typeof line2 !== 'string') return null;
  if (!/^1 /.test(line1) || !/^2 /.test(line2)) return null;
  const noradId = line1.substring(2, 7).trim();
  const epochYear = numOrNull(line1.substring(18, 20));
  const epochDay = numOrNull(line1.substring(20, 32));
  // Columns 34–43 hold ṅ/2 by TLE convention (CelesTrak format doc) —
  // double to recover the true first derivative of mean motion.
  const ndotHalf = numOrNull(line1.substring(33, 43));
  const ndot = ndotHalf === null ? null : 2 * ndotHalf;
  const bstar = parseImpliedFloat(line1.substring(53, 61));
  const inclDeg = numOrNull(line2.substring(8, 16));
  const ecc = numOrNull(`0.${line2.substring(26, 33).trim()}`);
  const meanMotion = numOrNull(line2.substring(52, 63));
  if (
    [epochYear, epochDay, ndot, inclDeg, ecc, meanMotion].some(
      (v) => v === null,
    )
  )
    return null;
  if (meanMotion <= 0 || ecc < 0 || ecc >= 1) return null;
  const fullYear = epochYear < 57 ? 2000 + epochYear : 1900 + epochYear;
  const epochMs = Date.UTC(fullYear, 0, 1) + (epochDay - 1) * 86400_000;
  return {
    noradId,
    epochUtc: new Date(epochMs).toISOString(),
    ndot,
    bstar,
    inclDeg,
    ecc,
    meanMotion,
  };
}

/**
 * Decay prediction from elements. Returns null when the object is not a
 * decay candidate (no positive drag, perigee too high, or prediction absurd).
 */
export function predictDecay(
  el,
  { maxDays = 120, perigeeCeilingKm = 400 } = {},
) {
  if (!el || !(el.ndot > 0)) return null;
  const nRadS = (el.meanMotion * 2 * Math.PI) / 86400;
  const a = (MU_KM3_S2 / nRadS ** 2) ** (1 / 3);
  const perigeeKm = a * (1 - el.ecc) - EARTH_RADIUS_KM;
  const apogeeKm = a * (1 + el.ecc) - EARTH_RADIUS_KM;
  if (!(perigeeKm < perigeeCeilingKm)) return null;
  const daysToDecay = (N_CRIT_REV_DAY - el.meanMotion) / el.ndot;
  if (!(daysToDecay > 0) || !(daysToDecay <= maxDays)) return null;
  const predictedMs = Date.parse(el.epochUtc) + daysToDecay * 86400_000;
  return {
    perigeeKm,
    apogeeKm,
    daysToDecay,
    predictedDecayUtc: new Date(predictedMs).toISOString(),
    uncertaintyDays: Math.max(0.5, 0.25 * daysToDecay),
  };
}

/** Imminence label for the countdown theater. */
export function decayUrgency(daysToDecay) {
  if (!(daysToDecay > 0)) return 'unknown';
  if (daysToDecay <= 3) return 'imminent';
  if (daysToDecay <= 14) return 'weeks';
  return 'watch';
}
