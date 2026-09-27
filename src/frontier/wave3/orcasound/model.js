/**
 * Wave 3 / Track 3b — Orcasound pure helpers (Cesium-free, node-testable).
 */

/** Escape HTML. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** "48.56°N 123.17°W" style coordinates. */
export function fmtCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
  const la = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${la} ${lo}`;
}
