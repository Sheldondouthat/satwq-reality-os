/**
 * Wave 9 — MIROVA volcano thermal hotspots — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/mirova.
 *
 * HONESTY: VRP (Volcanic Radiative Power, MW) is a MODIS/VIIRS heat-flux
 * proxy, not lava volume — valueLine names the hottest volcano and its VRP
 * but never implies an eruption. The feed is MIROVA's latest-detections
 * list; a volcano absent from it has no current detection, not "no data".
 * valueLine returns null when the payload carries no usable summary; the
 * detail line names the top-4 hottest volcanoes with their MIROVA alert
 * levels (carried verbatim from the provider).
 */
import {
  isUnavailable,
  withTags,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/mirova';
export const EMOJI = '🌋';
export const LABEL = 'MIROVA volcano hotspots';

function topDetections(doc, n) {
  const ds = Array.isArray(doc?.detections) ? doc.detections : [];
  return ds
    .filter((d) => d && d.vrpMw != null)
    .sort((a, b) => b.vrpMw - a.vrpMw)
    .slice(0, n);
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const n = pickNum(doc.summary?.detections);
  if (n == null) return null;
  const top = topDetections(doc, 1)[0];
  const hot = top ? ` hottest ${top.name} ${top.vrpMw} MW` : '';
  return withTags(`${EMOJI} MIROVA: ${n} hotspot detection${n === 1 ? '' : 's'}${hot}`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const tops = topDetections(doc, 4);
  const parts = [];
  if (tops.length) {
    parts.push(
      tops
        .map((d) => `${d.name} ${d.vrpMw} MW (${d.level || 'unlevelled'}, ${d.sensor || '?'})`)
        .join(' · ')
    );
  } else {
    parts.push('No current MIROVA thermal detections — a quiet planet is real data, not a gap.');
  }
  parts.push('VRP is a satellite heat-flux proxy, not lava volume; levels are MIROVA\u2019s own.');
  return parts.join(' ');
}
