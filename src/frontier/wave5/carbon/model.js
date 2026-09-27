/**
 * Wave 5 — grid carbon intensity ticker model (pure, no Cesium, no DOM).
 */

/** Presentation color for a National Grid ESO intensity index. */
export function indexColor(index) {
  const k = String(index ?? '').toLowerCase();
  if (k === 'very low') return '#59d98c';
  if (k === 'low') return '#a8d95e';
  if (k === 'moderate') return '#f5c542';
  if (k === 'high') return '#ff8a3d';
  if (k === 'very high') return '#ff5a5a';
  return '#8a93a6';
}

/** "97 gCO₂/kWh" or null. */
export function formatIntensity(value) {
  if (!Number.isFinite(value)) return null;
  return `${Math.round(value)} gCO₂/kWh`;
}

/** One-line ticker summary of a /api/carbon payload; null on bad payload. */
export function tickerSummary(payload) {
  if (!payload || !Number.isFinite(payload.value)) return null;
  return {
    value: formatIntensity(payload.value),
    index: payload.index ?? 'unknown',
    color: indexColor(payload.index),
    isForecast: payload.valueIsForecast === true,
    window:
      payload.from && payload.to
        ? `${payload.from} → ${payload.to}`
        : null,
  };
}
