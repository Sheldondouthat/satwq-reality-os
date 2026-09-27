/**
 * Wave 3 / Track 3b.9 — shortwave oracle pure helpers (Cesium-free, node-testable).
 */

/** Bar color for a listenability score (null = no data). */
export function scoreColor(score) {
  if (score === null || score === undefined) return '#55607a';
  if (score >= 70) return '#4dd0a6';
  if (score >= 40) return '#ffd166';
  if (score >= 10) return '#ff9f43';
  return '#ff5a5a';
}

/** "14.2 MHz" style formatting; '—' when unknown. */
export function fmtMhz(v, digits = 1) {
  return Number.isFinite(v) ? `${v.toFixed(digits)} MHz` : '—';
}

/** Compact solar summary line for the dock header. */
export function solarLine(solar) {
  if (!solar) return 'solar data unavailable';
  const flux = Number.isFinite(solar.flux10cm) ? `F10.7 ${Math.round(solar.flux10cm)}` : 'F10.7 —';
  const kp = Number.isFinite(solar.kp) ? `Kp ${solar.kp}` : 'Kp —';
  return `${flux} · ${kp}`;
}

/** Escape HTML for station names rendered into the panel. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
