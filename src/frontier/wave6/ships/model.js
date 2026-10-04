/**
 * Wave 6 — merged vessel picture (aiscast + Digitraffic + EuRIS).
 *
 * Ticker model (pure, no DOM) for GET /api/ships.
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

export const ROUTE = '/api/ships';
export const EMOJI = '🚢';
export const LABEL = 'Ships (merged)';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const n = pickNum(doc.count, doc.merged, doc.ships?.length);
  if (n == null) return null;
  return withTags(`${EMOJI} ${n.toLocaleString('en-US')} vessels tracked`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const s = pickArr(doc.ships)[0];
  const first = s ? pickStr(s.name, s.mmsi, 'vessel') : '';
  const health = sourceHealthLine(doc);
  return [first && `e.g. ${first}`, health].filter(Boolean).join(' · ');
}
