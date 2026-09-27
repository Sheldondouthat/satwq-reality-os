/**
 * Wave 3 / Track 3b — Sargassum watch pure helpers (Cesium-free, node-testable).
 */

/** "Sep 25, 2026" from an analysis date YYYYMMDD. */
export function formatAnalysisDate(dateStr) {
  if (!/^\d{8}$/.test(dateStr || '')) return '—';
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(4, 6)) - 1;
  const d = Number(dateStr.slice(6, 8));
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (m < 0 || m > 11 || d < 1 || d > 31) return '—';
  return `${months[m]} ${d}, ${y}`;
}

/** Escape HTML. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
