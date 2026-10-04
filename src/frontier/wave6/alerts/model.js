/**
 * Wave 6 — merged weather alerts (NWS + DWD).
 *
 * Ticker model (pure, no DOM) for GET /api/alerts.
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

export const ROUTE = '/api/alerts';
export const EMOJI = '⚠️';
export const LABEL = 'Alerts (NWS + DWD)';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const n = pickNum(doc.count, doc.alerts?.length);
  if (n == null) return null;
  return withTags(`${EMOJI} ${n.toLocaleString('en-US')} active alerts`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const heads = pickArr(doc.alerts)
    .slice(0, 2)
    .map((a) => pickStr(a.headline, a.event))
    .filter(Boolean);
  return heads.length ? heads.join(' · ') : '';
}
