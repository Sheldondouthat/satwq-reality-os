/**
 * Wave 3 / Track 2a.3 — Sensor.Community haze-field client model (pure).
 *
 * HONESTY: colors map PM2.5 through US EPA breakpoints to 1-6 categories.
 * That mapping is an ESTIMATE (the provider labels it `aqiModel`), not an
 * official AQI. The legend states this.
 */

export const AQI_COLORS = [
  '#3ddc84',
  '#ffe14d',
  '#ff9f43',
  '#ff5a5a',
  '#b366ff',
  '#8b1a3d',
];
export const AQI_NAMES = [
  'Good',
  'Moderate',
  'USG',
  'Unhealthy',
  'Very unhealthy',
  'Hazardous',
];

export function aqiColor(aqi) {
  if (!Number.isFinite(aqi) || aqi < 1 || aqi > 6) return '#8a93a6';
  return AQI_COLORS[aqi - 1];
}

export function aqiName(aqi) {
  if (!Number.isFinite(aqi) || aqi < 1 || aqi > 6) return 'n/a';
  return AQI_NAMES[aqi - 1];
}

/** Haze-disc radius in metres, growing with severity. */
export function hazeRadiusM(aqi) {
  if (!Number.isFinite(aqi) || aqi < 1) return 1200;
  return 1500 + (aqi - 1) * 900;
}

export function formatPm(v) {
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(1)} µg/m³`;
}

export function sensorLabel(s) {
  const parts = [`sensor ${s?.id ?? '?'}`];
  if (Number.isFinite(s?.pm25)) parts.push(`PM2.5 ${formatPm(s.pm25)}`);
  if (Number.isFinite(s?.pm10)) parts.push(`PM10 ${formatPm(s.pm10)}`);
  if (Number.isFinite(s?.aqi)) parts.push(`${aqiName(s.aqi)} (est.)`);
  return parts.join(' · ');
}

export function summaryText(summary) {
  if (!summary || summary.withPm25 === 0) return 'no PM2.5 sensors in view';
  const avg = summary.avgPm25 != null ? formatPm(summary.avgPm25) : '—';
  return `${summary.count} sensors · avg PM2.5 ${avg} · worst ${aqiName(summary.worstAqi)} (est.)`;
}
