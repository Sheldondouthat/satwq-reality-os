/**
 * Wave 8 — findu APRS position/weather lookup.
 *
 * Ticker model (pure, no DOM) for GET /api/findu.
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

export const ROUTE = '/api/findu';
export const EMOJI = '📍';
export const LABEL = 'findu (APRS)';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const call = pickStr(doc.callsign, 'findu');
      return withTags(`${EMOJI} ${call}: ${doc.hasReports ? 'position reports' : 'no reports'}`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      const f = doc.fields ?? {};
      const bits = [];
      if (pickStr(f.temperature)) bits.push(`temp ${f.temperature}`);
      if (pickStr(f.humidity)) bits.push(`hum ${f.humidity}`);
      if (pickStr(f.pressure)) bits.push(`pres ${f.pressure}`);
      return bits.length ? bits.join(' · ') : 'no wx fields';
    }
export function links(doc) {
      return doc.pageUrl ? [{ href: String(doc.pageUrl), text: 'findu page' }] : [];
    }
