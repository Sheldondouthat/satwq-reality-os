/**
 * Wave 6 — magnetometer plot manifest (IRF + UCalgary HAPI).
 *
 * Ticker model (pure, no DOM) for GET /api/magnetometers.
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

export const ROUTE = '/api/magnetometers';
export const EMOJI = '🧲';
export const LABEL = 'Magnetometers';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const irf = doc.sources?.irf;
      const hapi = doc.sources?.hapi;
      const parts = [];
      if (irf) parts.push(`IRF ${pickNum(irf.count) ?? '?'} plots`);
      if (hapi) parts.push(`HAPI ${pickNum(hapi.liveCount) ?? '?'}/${pickNum(hapi.requested) ?? '?'} live`);
      if (!parts.length) return null;
      return withTags(`${EMOJI} ${parts.join(' · ')}`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      return pickStr(doc.sources?.irf?.note, '');
    }
