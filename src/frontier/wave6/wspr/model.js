/**
 * Wave 6 — WSPR live propagation spots — who is hearing whom, worldwide.
 *
 * Ticker model (pure, no DOM) for GET /api/wspr-live.
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

export const ROUTE = '/api/wspr-live';
export const EMOJI = '📡';
export const LABEL = 'WSPR (live propagation spots)';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const n = pickNum(doc.count, doc.spots?.length);
  if (n == null) return null;
  return withTags(
    `${EMOJI} ${n.toLocaleString('en-US')} WSPR spots (last hour)`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const newest = pickArr(doc.spots)[0];
  if (!newest) return '';
  const tx = pickStr(newest.txCall, '?');
  const rx = pickStr(newest.rxCall, '?');
  const freq = pickNum(newest.freqMHz);
  return `newest: ${tx}→${rx} ${freq ?? '?'} MHz`;
}
