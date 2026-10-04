/**
 * Wave 6 — whale detections (Happywhale + Happy-whale platforms).
 *
 * Ticker model (pure, no DOM) for GET /api/whales.
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

export const ROUTE = '/api/whales';
export const EMOJI = '🐋';
export const LABEL = 'Whale detections';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const n = pickNum(doc.count, doc.detections?.length);
  if (n == null) return null;
  return withTags(
    `${EMOJI} ${n.toLocaleString('en-US')} whale detections`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const d = pickArr(doc.detections)[0];
  const what = d ? pickStr(d.species, d.commonName, 'whale') : '';
  const plats = pickArr(doc.platforms).length;
  return [what && `e.g. ${what}`, plats ? `${plats} platforms` : '']
    .filter(Boolean)
    .join(' · ');
}
