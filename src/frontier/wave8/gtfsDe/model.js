/**
 * Wave 8 — German GTFS-RT snapshot (snapshot pipeline).
 *
 * Ticker model (pure, no DOM) for GET /api/gtfs-de.
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

export const ROUTE = '/api/gtfs-de';
export const EMOJI = '🚏';
export const LABEL = 'GTFS-DE transit';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      if (!doc.snapshot) return `${EMOJI} GTFS-DE snapshot pending`;
      const c = doc.counts ?? {};
      const parts = ['tripUpdates', 'alerts', 'deleted']
        .map((k) => (pickNum(c[k]) != null ? `${c[k].toLocaleString('en-US')} ${k}` : ''))
        .filter(Boolean);
      return withTags(`${EMOJI} GTFS-DE${parts.length ? ` · ${parts.join(' · ')}` : ''}`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      if (!doc.snapshot) return 'no snapshot yet — pipeline pending';
      const top = pickArr(doc.topDelayed)[0];
      if (!top) return '';
      const delay = pickNum(top.delayMin, top.delaySec != null ? top.delaySec / 60 : null);
      return `most delayed: ${pickStr(top.route, top.trip, top.id, 'trip')}${delay != null ? ` +${Math.round(delay)}m` : ''}`;
    }
