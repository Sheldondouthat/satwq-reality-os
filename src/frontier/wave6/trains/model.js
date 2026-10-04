/**
 * Wave 6 — live train positions (multi-agency).
 *
 * Ticker model (pure, no DOM) for GET /api/trains.
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
  sourceHealthLine,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/trains';
export const EMOJI = '🚂';
export const LABEL = 'Trains';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const n = pickNum(doc.count, doc.trains?.length);
  if (n == null) return null;
  return withTags(`${EMOJI} ${n.toLocaleString('en-US')} trains tracked`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const tr = pickArr(doc.trains)[0];
  const first = tr ? pickStr(tr.route, tr.headsign, tr.line, 'train') : '';
  const health = sourceHealthLine(doc);
  return [first && `e.g. ${first}`, health].filter(Boolean).join(' · ');
}
