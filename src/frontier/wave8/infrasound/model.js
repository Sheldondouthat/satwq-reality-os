/**
 * Wave 8 — IMS infrasound station series (EarthScope).
 *
 * Ticker model (pure, no DOM) for GET /api/infrasound-ims.
 *
 * HONESTY: valueLine returns null when the payload carries no usable number
 * (the ticker then shows "unavailable — will retry"); withTags() appends
 * (stale)/(partial)/(model: simulation, not sensors) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
  pickStr,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/infrasound-ims';
export const EMOJI = '🔊';
export const LABEL = 'IMS infrasound';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const st = doc.station ?? {};
  const id = pickStr(st.station, st.sid, 'IMS');
  return withTags(`${EMOJI} IMS ${id} infrasound`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const st = doc.station ?? {};
  const lat = pickNum(st.lat);
  const lon = pickNum(st.lon);
  return `${pickStr(st.network, '')}${lat != null && lon != null ? ` · ${lat}, ${lon}` : ''}`.replace(
    /^ · /,
    '',
  );
}
