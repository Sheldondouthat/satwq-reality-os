/**
 * Wave 5 — CO₂ ticker model (pure, no Cesium, no DOM).
 *
 * Mauna Loa daily mean CO₂: format + trend presentation helpers.
 */

/** "429.03 ppm" or null on garbage. */
export function formatPpm(ppm) {
  if (!Number.isFinite(ppm)) return null;
  return `${Math.round(ppm * 100) / 100} ppm`;
}

/** Trend arrow for a year-ago delta: ▲ up, ▼ down, ▬ flat/none. */
export function trendGlyph(delta1yPpm) {
  if (!Number.isFinite(delta1yPpm)) return '▬';
  if (delta1yPpm > 0.005) return '▲';
  if (delta1yPpm < -0.005) return '▼';
  return '▬';
}

/** "+2.72 ppm vs 2025-09-24" or null when the year-ago leg is missing. */
export function deltaLine(delta1yPpm, delta1yDate) {
  if (!Number.isFinite(delta1yPpm)) return null;
  const sign = delta1yPpm > 0 ? '+' : delta1yPpm < 0 ? '−' : '±';
  const abs = Math.abs(Math.round(delta1yPpm * 100) / 100);
  return `${sign}${abs} ppm vs ${delta1yDate ?? 'a year ago'}`;
}

/** One-line ticker summary of a /api/co2 payload; null on bad payload. */
export function tickerSummary(payload) {
  if (!payload || !Number.isFinite(payload.ppm)) return null;
  const value = formatPpm(payload.ppm);
  const delta = deltaLine(payload.delta1yPpm, payload.delta1yDate);
  return {
    value,
    glyph: trendGlyph(payload.delta1yPpm),
    delta,
    date: payload.date ?? null,
  };
}
