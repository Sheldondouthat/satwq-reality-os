/**
 * Wave 9 — NASA Ozone Watch annual maxima — ticker model (pure, no DOM).
 *
 * HONESTY: ANNUAL maxima only (one row per year). The 2025 row is the
 * latest published; the 2026 ozone season had not produced a maximum at
 * file-capture time.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/ozone';
export const EMOJI = '🕳️';
export const LABEL = 'Ozone hole';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const latest = doc.latest;
  const area = pickNum(latest?.maxHoleArea?.valueMkm2);
  const ozone = pickNum(latest?.minOzone?.valueDU);
  const year = pickNum(latest?.year);
  if (area == null && ozone == null) return null;
  const parts = [];
  if (year != null) parts.push(`${year}`);
  if (area != null) parts.push(`hole ${area.toFixed(1)}M km²`);
  if (ozone != null) parts.push(`min ${ozone} DU`);
  return withTags(`${EMOJI} ozone: ${parts.join(' · ')}`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const parts = [];
  const latest = doc.latest || {};
  if (latest.year != null) {
    parts.push(
      `${latest.year}: max hole area ${latest.maxHoleArea?.valueMkm2?.toFixed(1) ?? '?'}M km² ` +
      `(${latest.maxHoleArea?.date ?? '?'}), min ozone ${latest.minOzone?.valueDU ?? '?'} DU ` +
      `(${latest.minOzone?.date ?? '?'}).`
    );
  }
  const rec = doc.records || {};
  if (rec.largestHole?.valueMkm2 != null) {
    parts.push(`Record: largest hole ${rec.largestHole.valueMkm2.toFixed(1)}M km² in ${rec.largestHole.year}.`);
  }
  if (rec.lowestOzone?.valueDU != null) {
    parts.push(`Lowest ozone ${rec.lowestOzone.valueDU} DU in ${rec.lowestOzone.year}.`);
  }
  if (!parts.length) parts.push('No ozone data in this payload.');
  parts.push('Annual maxima (TOMS/OMI/OMPS + MERRA fill), Southern Hemisphere, CC-BY — not daily values.');
  return parts.join(' ');
}
