/**
 * Wave 5 — UV ticker model (pure, no Cesium, no DOM).
 *
 * WHO/standard UV-index bands with presentation colors.
 */

/** WHO UV band: {label, color}. */
export function uvBand(uvIndex) {
  if (!Number.isFinite(uvIndex)) return { label: 'unknown', color: '#8a93a6' };
  if (uvIndex < 3) return { label: 'Low', color: '#59d98c' };
  if (uvIndex < 6) return { label: 'Moderate', color: '#f5c542' };
  if (uvIndex < 8) return { label: 'High', color: '#ff8a3d' };
  if (uvIndex < 11) return { label: 'Very high', color: '#ff5a5a' };
  return { label: 'Extreme', color: '#c44dff' };
}

/** "4.2" or null. */
export function formatUv(uvIndex) {
  if (!Number.isFinite(uvIndex)) return null;
  return `${Math.round(uvIndex * 10) / 10}`;
}

/** "19:12" from an ISO local timestamp, else the raw string. */
export function shortTime(iso) {
  if (typeof iso !== 'string') return null;
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : iso;
}

/** One-line ticker summary of a /api/uv payload; null on bad payload. */
export function tickerSummary(payload) {
  if (!payload || !Number.isFinite(payload.uvIndex)) return null;
  const band = uvBand(payload.uvIndex);
  const max = Number.isFinite(payload.today?.uvIndexMax)
    ? payload.today.uvIndexMax
    : null;
  return {
    value: `UV ${formatUv(payload.uvIndex)}`,
    band: band.label,
    color: band.color,
    isDay: payload.current?.isDay ?? null,
    tempC: payload.current?.temperatureC ?? null,
    todayMax: max !== null ? `max ${formatUv(max)}` : null,
    sun:
      payload.today?.sunrise && payload.today?.sunset
        ? `↑${shortTime(payload.today.sunrise)} ↓${shortTime(payload.today.sunset)}`
        : null,
  };
}
