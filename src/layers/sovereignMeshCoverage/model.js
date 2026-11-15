/**
 * Sovereign Mesh coverage presentation model. Pure — no Cesium, no
 * network. Colors are the nodes layer's own margin palette (one
 * legend for the whole mesh family), and the attribution is the
 * coverage FeedSpec's own string, re-exported from the nodes model
 * so the two faces can never drift apart on it.
 */
import {
  MARGIN_STYLES,
  SOVEREIGN_MESH_COVERAGE_ATTRIBUTION,
  escapeHtml,
} from '../sovereignMesh/model.js';

export { SOVEREIGN_MESH_COVERAGE_ATTRIBUTION };

/** Translucency of a coverage cell's ground recolor. The recolor is
 * an overlay on the terrain, never a replacement for it. */
export const COVERAGE_FILL_ALPHA = 0.45;

/** Fill color for a coverage cell of the given predicted margin
 * class — the same hex the nodes layer draws that class's links in. */
export function coverageColorHex(marginClass) {
  return (MARGIN_STYLES[marginClass] || MARGIN_STYLES.unknown).colorHex;
}

const fmt = (v, suffix = '', digits = 1) =>
  typeof v === 'number' && Number.isFinite(v)
    ? `${v.toFixed(digits)}${suffix}`
    : '—';

/**
 * Entity description for one coverage cell: the prediction stated as
 * a prediction (Modeled, not measured), the best link's numbers, the
 * snapshot's own label and source carried through untouched (a
 * SYNTHETIC replay's coverage reads SYNTHETIC here too), and the
 * coverage attribution verbatim.
 */
export function coverageCellDescription(cell, header = {}) {
  const label = header.label || 'UNLABELED';
  const rows = [
    `<strong>Mesh coverage — best via ${escapeHtml(cell.bestShortname)}</strong>`,
    `Feed label: <strong>${escapeHtml(label)}</strong>` +
      (header.source ? ` · source: ${escapeHtml(header.source)}` : '') +
      (header.confidence
        ? ` · confidence: ${escapeHtml(header.confidence)}`
        : ''),
    `Predicted margin: <strong>${escapeHtml(cell.marginClass)}</strong>` +
      ` (${escapeHtml(cell.verdict)}) · ${fmt(cell.distKm, ' km', 2)} to ${escapeHtml(cell.bestShortname)}`,
    `Min clearance: ${fmt(cell.minClearM, ' m')}` +
      ` · Fresnel margin: ${fmt(cell.minFresnelMarginM, ' m')}` +
      ` · FSPL excess: ${fmt(cell.fsplExcessDb, ' dB')}`,
    'Computed locally from SRTM terrain and the node set — modeled, not measured.',
    `<em>${escapeHtml(SOVEREIGN_MESH_COVERAGE_ATTRIBUTION)}</em>`,
  ];
  return rows.join('<br/>');
}
