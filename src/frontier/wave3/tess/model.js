/**
 * Wave 3 / Track 3b — TESS transit alerts pure helpers (Cesium-free, node-testable).
 */

/** "in 3.2h" style countdown from hoursUntil. */
export function countdown(hoursUntil) {
  if (!Number.isFinite(hoursUntil)) return '—';
  if (hoursUntil < 0) return 'now';
  if (hoursUntil < 1) return `in ${Math.round(hoursUntil * 60)}m`;
  if (hoursUntil < 48) return `in ${hoursUntil.toFixed(1)}h`;
  return `in ${(hoursUntil / 24).toFixed(1)}d`;
}

/** Disposition badge text. */
export function dispositionLabel(d) {
  return d === 'CP' ? 'confirmed planet' : d === 'PC' ? 'planet candidate' : (d || 'unknown');
}

/** Escape HTML for TOI strings rendered into the panel. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
