/**
 * Wave 7 — live MBTA vehicles (normalized GTFS-RT).
 *
 * Ticker model (pure, no DOM) for GET /api/mbta.
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

export const ROUTE = '/api/mbta';
export const EMOJI = '🚇';
export const LABEL = 'MBTA vehicles';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const n = pickNum(doc.count, doc.vehicles?.length);
  if (n == null) return null;
  return withTags(`${EMOJI} ${n.toLocaleString('en-US')} MBTA vehicles`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const v = pickArr(doc.vehicles)[0];
  return v ? `e.g. ${pickStr(v.route, v.label, v.id, 'vehicle')}` : '';
}
