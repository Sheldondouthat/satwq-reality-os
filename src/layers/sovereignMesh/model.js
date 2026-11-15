/**
 * Sovereign Mesh presentation model. Pure — no Cesium, no network.
 * The attribution strings are the FeedSpec's own (BM3 §1), carried
 * verbatim; the falsifier (§7) fails any render without them.
 */

export const SOVEREIGN_MESH_NODES_ATTRIBUTION =
  "Sovereign Mesh — the operator's own LoRa mesh network (Part 15, 902-928 MHz). Node positions and telemetry reported by the operator's own nodes; served locally, not redistributed.";

export const SOVEREIGN_MESH_COVERAGE_ATTRIBUTION =
  "Sovereign Mesh coverage — computed locally from SRTM terrain (OpenTopoData) and the operator's own node set. Modeled, not measured.";

/** Node point color (mesh cyan); alpha comes from the staleness fade. */
export const NODE_COLOR_HEX = '#59d7ff';

/** Link styles by the bridge's margin class. */
export const MARGIN_STYLES = Object.freeze({
  strong: Object.freeze({ colorHex: '#37d67a', width: 3 }),
  workable: Object.freeze({ colorHex: '#ffd54a', width: 2 }),
  marginal: Object.freeze({ colorHex: '#ff7a59', width: 1.5 }),
  unknown: Object.freeze({ colorHex: '#9aa4b2', width: 1 }),
});

export function marginStyle(marginClass) {
  return MARGIN_STYLES[marginClass] || MARGIN_STYLES.unknown;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const fmt = (v, suffix = '') =>
  typeof v === 'number' && Number.isFinite(v) ? `${v}${suffix}` : '—';

/**
 * Entity description for one node: telemetry from the bridge record,
 * the feed's own label and source stated plainly (a SYNTHETIC replay
 * reads as SYNTHETIC here, in the click card, not just in a header
 * nobody opens), and the §1 attribution verbatim.
 */
export function nodeDescription(node, header = {}) {
  const label = header.label || node.label || 'UNLABELED';
  const rows = [
    `<strong>${escapeHtml(node.shortname)} — ${escapeHtml(node.name)}</strong>`,
    `Feed label: <strong>${escapeHtml(label)}</strong>` +
      (header.source ? ` · source: ${escapeHtml(header.source)}` : '') +
      (header.confidence
        ? ` · confidence: ${escapeHtml(header.confidence)}`
        : ''),
    node.hardware || node.role
      ? `Hardware: ${escapeHtml(node.hardware || '—')} · Role: ${escapeHtml(node.role || '—')}`
      : null,
    `Position: ${node.lat.toFixed(5)}, ${node.lon.toFixed(5)}` +
      ` · Alt (reported): ${fmt(node.altitudeM, ' m')}` +
      ` · Ground (SRTM): ${fmt(node.groundElevMSrtm, ' m')}`,
    `Battery: ${fmt(node.batteryLevel, '%')} · ${fmt(node.voltage, ' V')}` +
      ` · Air util TX: ${fmt(node.airUtilTx, '%')}` +
      ` · Channel util: ${fmt(node.channelUtilization, '%')}`,
    `Last heard: ${fmt(node.lastHeardAgeS, ' s')} ago`,
    `<em>${escapeHtml(SOVEREIGN_MESH_NODES_ATTRIBUTION)}</em>`,
  ].filter(Boolean);
  return rows.join('<br/>');
}

/** Entity description for one link line. */
export function linkDescription(link, nodesByShortname = new Map()) {
  const from = nodesByShortname.get(link.fromId) || link.fromId;
  const to = nodesByShortname.get(link.toId) || link.toId;
  return (
    `<strong>${escapeHtml(from)} → ${escapeHtml(to)}</strong><br/>` +
    `Link margin: ${escapeHtml(link.marginClass)}` +
    ` · SNR: ${fmt(link.snrDb, ' dB')}<br/>` +
    `<em>${escapeHtml(SOVEREIGN_MESH_NODES_ATTRIBUTION)}</em>`
  );
}
