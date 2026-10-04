/**
 * F2 — Planetary DVR: pure date math for the GIBS TIME-dimension scrubber.
 *
 * NASA GIBS WMTS REST exposes its TIME dimension as a YYYY-MM-DD path
 * segment: {BASE}/{LAYER}/default/{DATE}/{MATRIXSET}/{z}/{y}/{x}.{ext}.
 * Everything here is pure (no Cesium, no DOM) so it is unit-testable.
 */

export const GIBS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Default scrub window: ~30 days of daily GIBS true-color frames. */
export const DVR_DEFAULT_DAYS = 30;

/** GIBS "best" daily layers lag ~1 day behind real time. */
export const GIBS_LAG_DAYS = 1;

/** A real calendar date in YYYY-MM-DD form (rejects e.g. 2026-02-30). */
export function isValidGibsDate(value) {
  if (typeof value !== 'string' || !GIBS_DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** Format a millisecond epoch as a GIBS YYYY-MM-DD date (UTC). */
export function formatGibsDateUTC(ms) {
  if (!Number.isFinite(ms))
    throw new TypeError('formatGibsDateUTC needs a finite epoch ms');
  return new Date(ms).toISOString().slice(0, 10);
}

/** Parse a YYYY-MM-DD date to a UTC-midnight epoch. Throws on invalid input. */
export function gibsDateToMs(dateStr) {
  if (!isValidGibsDate(dateStr))
    throw new TypeError(`Invalid GIBS date: ${JSON.stringify(dateStr)}`);
  return Date.parse(`${dateStr}T00:00:00Z`);
}

/**
 * The scrub window: `{ min, max, days }` where min/max are YYYY-MM-DD and
 * `days` is the ordered list of every date in the window. `max` is yesterday
 * (GIBS lag); the window covers the `days` days ending there.
 */
export function dvrDateRange({
  nowMs = Date.now(),
  days = DVR_DEFAULT_DAYS,
} = {}) {
  const n = Math.max(1, Math.floor(days));
  const max = formatGibsDateUTC(
    Date.UTC(
      new Date(nowMs).getUTCFullYear(),
      new Date(nowMs).getUTCMonth(),
      new Date(nowMs).getUTCDate(),
    ) -
      GIBS_LAG_DAYS * 86400000,
  );
  const maxMs = gibsDateToMs(max);
  const list = [];
  for (let i = n - 1; i >= 0; i--) {
    list.push(formatGibsDateUTC(maxMs - i * 86400000));
  }
  return { min: list[0], max, days: list };
}

/** Clamp a YYYY-MM-DD date into a range (inclusive). Throws on invalid input. */
export function clampGibsDate(dateStr, { min, max }) {
  if (!isValidGibsDate(dateStr))
    throw new TypeError(`Invalid GIBS date: ${JSON.stringify(dateStr)}`);
  if (dateStr < min) return min;
  if (dateStr > max) return max;
  return dateStr;
}

/** Slider index (0 = oldest) for a date inside a range's day list. */
export function dateToIndex(dateStr, range) {
  const idx = range.days.indexOf(dateStr);
  return idx < 0 ? -1 : idx;
}

/** Date string for a slider index, clamped into the range. */
export function indexToDate(index, range) {
  const i = Math.min(range.days.length - 1, Math.max(0, Math.floor(index)));
  return range.days[i];
}

/**
 * Normalize a GIBS `layer-time-actual` response header
 * (e.g. "2026-09-25T00:00:00Z") to YYYY-MM-DD. Returns null when the header
 * is absent or unparseable.
 */
export function parseLayerTimeActual(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(headerValue.trim());
  return m && isValidGibsDate(m[1]) ? m[1] : null;
}

/**
 * Decide availability from a tile-probe outcome: a date is available only
 * when the tile request succeeded AND GIBS served the requested date
 * (GIBS "best" silently substitutes the nearest available frame otherwise).
 */
export function isDateAvailable({ ok, actualDate, requestedDate }) {
  return ok === true && actualDate === requestedDate;
}
