/**
 * Wave 3 / Track 3b — Cumiana Schumann panel pure helpers (Cesium-free, node-testable).
 */

/** Escape HTML. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
