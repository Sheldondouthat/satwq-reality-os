/**
 * Wave 6 — NOAA tide-gauge water levels (default Sewells Point VA).
 *
 * Ticker model (pure, no DOM) for GET /api/tides.
 *
 * HONESTY: valueLine returns null when the payload carries no usable number
 * (the ticker then shows "unavailable — will retry"); withTags() appends
 * (stale)/(partial)/(model: simulation, not sensors) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
  pickArr,
  pickStr,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/tides';
export const EMOJI = '📏';
export const LABEL = 'Tide gauges';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const wl = pickArr(doc.waterLevel);
  const last = wl[wl.length - 1];
  const feet = pickNum(last?.feet);
  if (feet == null) return null;
  return withTags(
    `${EMOJI} ${feet} ft @ ${pickStr(doc.station, 'tide gauge')}`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const wl = pickArr(doc.waterLevel);
  const last = wl[wl.length - 1];
  return `${wl.length} readings${last?.time ? ` · latest ${last.time}` : ''}`;
}
