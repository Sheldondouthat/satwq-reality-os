/**
 * Wave 6 — satellite transmitter frequency database (SatNOGS).
 *
 * Ticker model (pure, no DOM) for GET /api/frequencies.
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

export const ROUTE = '/api/frequencies';
export const EMOJI = '📡';
export const LABEL = 'Satellite frequencies';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const shown = pickNum(doc.shown, doc.transmitters?.length);
      if (shown == null) return null;
      const total = pickNum(doc.total);
      return withTags(`${EMOJI} ${shown.toLocaleString('en-US')}${total != null ? `/${total.toLocaleString('en-US')}` : ''} satellite transmitters`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      const tx = pickArr(doc.transmitters)[0];
      if (!tx) return '';
      return `${pickStr(tx.satellite, 'satellite')}${pickStr(tx.mode) ? ` · ${tx.mode}` : ''}${tx.alive === false ? ' · silent' : ''}`;
    }
