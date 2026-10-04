/**
 * Wave 6 — merged aircraft picture (OpenSky + adsb.lol).
 *
 * Ticker model (pure, no DOM) for GET /api/aircraft.
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

export const ROUTE = '/api/aircraft';
export const EMOJI = '✈️';
export const LABEL = 'Aircraft (merged)';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const n = pickNum(doc.count, doc.merged, doc.aircraft?.length);
  if (n == null) return null;
  return withTags(
    `${EMOJI} ${n.toLocaleString('en-US')} aircraft tracked`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const a = pickArr(doc.aircraft)[0];
  const first = a ? pickStr(a.callsign, a.hex, 'aircraft') : '';
  const health = sourceHealthLine(doc);
  return [first && `e.g. ${first}`, health].filter(Boolean).join(' · ');
}
