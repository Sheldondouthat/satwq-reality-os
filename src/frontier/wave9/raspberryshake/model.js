/**
 * Wave 9 — Raspberry Shake citizen-seismometer network — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/raspberryshake.
 *
 * HONESTY: the payload is REGISTRY metadata (FDSN Station text), not
 * real-time data flow. "active" = the registry lists an epoch with no
 * EndTime — it may lag actual streaming by hours. valueLine returns null
 * when the payload carries no usable summary; the detail line names the
 * densest 10°x10° cells and the week's joiners/retirees.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/raspberryshake';
export const EMOJI = '📳';
export const LABEL = 'Raspberry Shake network';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const active = pickNum(doc.summary?.active);
  const total = pickNum(doc.summary?.totalStations);
  if (active == null || total == null) return null;
  return withTags(
    `${EMOJI} Raspberry Shake: ${active.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} citizen seismometers listed active`,
    doc
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const parts = [];
  const cells = Array.isArray(doc.density) ? doc.density.slice(0, 3) : [];
  if (cells.length) {
    parts.push(
      'Densest cells: ' +
        cells.map((c) => `${c.cell} (${c.count})`).join(' · ')
    );
  }
  const nw = pickNum(doc.summary?.newWeek);
  const rw = pickNum(doc.summary?.retiredWeek);
  if (nw != null || rw != null) {
    parts.push(`${nw ?? 0} joined / ${rw ?? 0} retired in the last 7 days (registry epochs).`);
  }
  parts.push('Registry metadata, not live data flow — a listed-open station can be dark.');
  return parts.join(' ');
}
