/**
 * Wave 6 — comet ephemerides + observations (COBS).
 *
 * Ticker model (pure, no DOM) for GET /api/comets.
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

export const ROUTE = '/api/comets';
export const EMOJI = '☄️';
export const LABEL = 'Comets';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const n = pickNum(doc.count, doc.comets?.length);
  if (n == null) return null;
  const obs = pickArr(doc.observations).length;
  return withTags(
    `${EMOJI} ${n} comets${obs ? ` · ${obs} observations` : ''}`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const c = pickArr(doc.comets)[0];
  return c ? `e.g. ${pickStr(c.designation, c.name, 'comet')}` : '';
}
