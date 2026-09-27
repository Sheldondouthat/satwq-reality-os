/**
 * Wave 7 — BirdCast migration dashboard embed metadata.
 *
 * Ticker model (pure, no DOM) for GET /api/birdcast-dash.
 *
 * HONESTY: valueLine returns null when the payload carries no usable number
 * (the ticker then shows "unavailable — will retry"); withTags() appends
 * (stale)/(partial)/(model: simulation, not sensors) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickStr,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/birdcast-dash';
export const EMOJI = '🗺️';
export const LABEL = 'BirdCast dashboard';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      return withTags(`${EMOJI} BirdCast migration dashboard`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      return `${pickStr(doc.title, 'BirdCast dashboard')} · probe ${pickStr(doc.probe, 'n/a')}`;
    }
export function links(doc) {
      return doc.embedUrl ? [{ href: String(doc.embedUrl), text: 'open dashboard' }] : [];
    }
