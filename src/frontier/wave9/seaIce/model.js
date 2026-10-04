/**
 * Wave 9 — NSIDC daily sea-ice extent — ticker model (pure, no DOM).
 *
 * HONESTY: extent is satellite-derived (NASA Team, 15% cutoff), not
 * thickness. The day-of-year anomaly is vs this file's full-record
 * day-of-year mean, NOT the official 1981-2010 baseline.
 */
import { isUnavailable, withTags, pickNum } from '../../wave3/common/ticker.js';

export const ROUTE = '/api/sea-ice';
export const EMOJI = '🧊';
export const LABEL = 'Sea ice extent';

function fmtExtent(v) {
  const n = pickNum(v);
  return n == null ? null : `${n.toFixed(2)}M km²`;
}

function fmtAnomaly(v) {
  const n = pickNum(v);
  if (n == null) return null;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)} vs record avg`;
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const hemis = doc.hemispheres || [];
  const parts = [];
  for (const h of hemis) {
    if (!h?.ok) continue;
    const ext = fmtExtent(h.latest?.extentMkm2);
    const anom = fmtAnomaly(h.dayOfYear?.anomalyMkm2);
    if (ext == null) continue;
    const name =
      h.hemi === 'north' ? 'Arctic' : h.hemi === 'south' ? 'Antarctic' : h.hemi;
    parts.push(anom ? `${name} ${ext} (${anom})` : `${name} ${ext}`);
  }
  if (!parts.length) return null;
  return withTags(`${EMOJI} sea ice: ${parts.join(' · ')}`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const parts = [];
  for (const h of doc.hemispheres || []) {
    if (!h?.ok) continue;
    const name = h.hemi === 'north' ? 'Arctic' : 'Antarctic';
    const l = h.latest || {};
    const d = h.dayOfYear || {};
    parts.push(
      `${name}: ${l.extentMkm2?.toFixed(2) ?? '?'}M km² on ${l.date ?? '?'}. ` +
        `Day-of-year record mean ${d.recordMeanMkm2?.toFixed(2) ?? '?'}M km² (n=${d.recordN ?? '?'}), ` +
        `range ${d.recordMin?.value?.toFixed(2) ?? '?'}-${d.recordMax?.value?.toFixed(2) ?? '?'}M km².`,
    );
  }
  if (!parts.length) parts.push('No sea-ice data in this payload.');
  parts.push(
    'NASA Team algorithm, 15% cutoff — extent, not thickness; anomaly vs file record mean, not the 1981-2010 baseline.',
  );
  return parts.join(' ');
}
