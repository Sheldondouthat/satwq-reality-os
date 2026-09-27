/**
 * Wave 6 — HF reception reports — who is hearing whom.
 *
 * Ticker model (pure, no DOM) for GET /api/pskreporter.
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

export const ROUTE = '/api/pskreporter';
export const EMOJI = '📻';
export const LABEL = 'PSKReporter (HF reception)';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const n = pickNum(doc.count, doc.reports?.length);
      if (n == null) return null;
      return withTags(`${EMOJI} ${n.toLocaleString('en-US')} reception reports (last hour)`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      const top = pickArr(doc.reports).slice(0, 3).map((r) =>
        `${pickStr(r.sender, '?')}→${pickStr(r.receiver, '?')} ${pickNum(r.freqMHz) ?? '?'} MHz ${pickStr(r.mode)}`.trim(),
      ).filter(Boolean);
      return top.length ? `latest: ${top.join(' · ')}` : '';
    }
