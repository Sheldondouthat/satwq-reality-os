/**
 * Wave 6 — radio meteor station counts (RMOB public feeds).
 *
 * Ticker model (pure, no DOM) for GET /api/meteor-stations.
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

export const ROUTE = '/api/meteor-stations';
export const EMOJI = '☄️';
export const LABEL = 'Meteor stations';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const stations = pickArr(doc.stations);
  const total =
    pickNum(doc.count) ??
    stations.reduce((sum, s) => sum + (pickNum(s?.totalCount) ?? 0), 0);
  if (total == null || total <= 0) return null;
  return withTags(
    `${EMOJI} ${total.toLocaleString('en-US')} radio meteors · ${stations.length} stations`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const stations = pickArr(doc.stations);
  const top = [...stations].sort(
    (a, b) => (pickNum(b?.totalCount) ?? 0) - (pickNum(a?.totalCount) ?? 0),
  )[0];
  return [
    top ? `top: ${pickStr(top.station, top.code, 'station')}` : '',
    `${stations.length} RMOB stations`,
  ]
    .filter(Boolean)
    .join(' · ');
}
