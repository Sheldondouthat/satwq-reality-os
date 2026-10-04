/**
 * Wave 6 — extended weather-station mesh (7 sources).
 *
 * Ticker model (pure, no DOM) for GET /api/stations-ext.
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

export const ROUTE = '/api/stations-ext';
export const EMOJI = '🌡️';
export const LABEL = 'Weather stations (ext)';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const n = pickNum(doc.stationCount, doc.stations?.length);
  if (n == null) return null;
  return withTags(
    `${EMOJI} ${n.toLocaleString('en-US')} weather stations`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const s = pickArr(doc.stations)[0];
  const first = s
    ? `${pickStr(s.name, s.id, 'station')}${pickStr(s.network) ? ` (${s.network})` : ''}`
    : '';
  const health = sourceHealthLine(doc);
  return [first && `e.g. ${first}`, health].filter(Boolean).join(' · ');
}
