/**
 * Validate the two NOAA SWPC ACE feeds and return the latest fully-valid
 * merged reading. Swepam rows carry the plasma values; mag rows are matched
 * by time_tag and contribute the GSM Bz component.
 *
 * Swepam row: { time_tag, dsflag, dens, speed, temperature } (nulls when bad).
 * Mag row:    { time_tag, dsflag, numpts, gsm_bx, gsm_by, gsm_bz, bt, ... }.
 */

function parseTimeMs(timeTag) {
  if (typeof timeTag !== 'string' || timeTag.length === 0) return NaN;
  // SWPC stamps are UTC; some carry no zone designator.
  const stamped = /[zZ]|[+-]\d{2}:?\d{2}$/.test(timeTag) ? timeTag : `${timeTag}Z`;
  return Date.parse(stamped);
}

/**
 * Number() coerces null -> 0, which would let nulled-out SWPC rows pass
 * validation as calm readings. Reject null/undefined/'' first.
 */
function finiteNum(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Number(value);
}

/**
 * @returns {{ timeMs, speedKms, densityPerCm3, tempK, bzGsm } | null}
 */
export function normalizeSpaceWeatherSnapshot(swepamPayload, magPayload) {
  if (!Array.isArray(swepamPayload) || swepamPayload.length === 0) return null;
  const magByTime = new Map();
  if (Array.isArray(magPayload)) {
    for (const row of magPayload) {
      if (row && typeof row === 'object' && typeof row.time_tag === 'string') {
        magByTime.set(row.time_tag, row);
      }
    }
  }
  // Feeds are time-ordered; the last fully-valid merged row wins.
  for (let i = swepamPayload.length - 1; i >= 0; i--) {
    const sw = swepamPayload[i];
    if (!sw || typeof sw !== 'object') continue;
    const timeMs = parseTimeMs(sw.time_tag);
    const speedKms = finiteNum(sw.speed);
    const densityPerCm3 = finiteNum(sw.dens);
    const tempK = finiteNum(sw.temperature);
    if (!Number.isFinite(timeMs)) continue;
    if (!Number.isFinite(speedKms) || speedKms < 0) continue;
    if (!Number.isFinite(densityPerCm3) || densityPerCm3 < 0) continue;
    if (!Number.isFinite(tempK) || tempK < 0) continue;
    const mag = magByTime.get(sw.time_tag);
    if (!mag || typeof mag !== 'object') continue;
    const bzGsm = finiteNum(mag.gsm_bz);
    if (!Number.isFinite(bzGsm)) continue;
    return { timeMs, speedKms, densityPerCm3, tempK, bzGsm };
  }
  return null;
}
