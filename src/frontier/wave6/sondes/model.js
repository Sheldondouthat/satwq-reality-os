/**
 * Wave 6 — radiosonde tracker (radiosondy.info).
 *
 * Ticker model (pure, no DOM) for GET /api/sondes.
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

export const ROUTE = '/api/sondes';
export const EMOJI = '🎈';
export const LABEL = 'Radiosondes';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const n = pickNum(doc.count, doc.sondes?.length);
  if (n == null) return null;
  const air = pickNum(doc.airborne);
  return withTags(
    `${EMOJI} ${air != null ? `${air}/` : ''}${n} radiosondes${air != null ? ' airborne' : ' tracked'}`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const s = pickArr(doc.sondes)[0];
  if (!s) return '';
  const alt = pickNum(s.altM);
  return `${pickStr(s.serial, s.id, 'sonde')}${alt != null ? ` · ${alt.toLocaleString('en-US')} m` : ''}${pickStr(s.uploader) ? ` · via ${s.uploader}` : ''}`;
}
