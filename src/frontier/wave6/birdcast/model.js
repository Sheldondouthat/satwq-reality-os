/**
 * Wave 6 — BirdCast nightly migration forecast.
 *
 * Ticker model (pure, no DOM) for GET /api/birdcast.
 *
 * HONESTY: valueLine returns null when the payload carries no usable number
 * (the ticker then shows "unavailable — will retry"); withTags() appends
 * (stale)/(partial)/(model: simulation, not sensors) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickStr,
  countOf,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/birdcast';
export const EMOJI = '🐦';
export const LABEL = 'BirdCast migration';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const date = pickStr(doc.date);
  if (!date && countOf(doc) == null) return null;
  return withTags(`${EMOJI} BirdCast${date ? ` ${date}` : ''}`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  return `latest map ${pickStr(doc.latest?.lastModified, 'n/a')}`;
}
