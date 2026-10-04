/**
 * Wave 5 — POTA "who's on the air" client model (pure, no Cesium).
 *
 * HONESTY: spots are live self/spotter reports from api.pota.app; park
 * coords are the registered park location (may lag new refs). Mode colors
 * are presentation only.
 */

/** Point color by mode: CW amber, SSB green, FT8/FM/digital blue, other gray. */
export function modeColor(mode) {
  const m = String(mode ?? '').toUpperCase();
  if (m === 'CW') return '#ffb454';
  if (m === 'SSB' || m === 'LSB' || m === 'USB') return '#4dd0a6';
  if (['FT8', 'FT4', 'FM', 'AM', 'PSK31', 'RTTY', 'DATA'].includes(m))
    return '#6aa8ff';
  return '#8a93a6';
}

/** Human band label from a kHz frequency. */
export function bandLabel(frequencyKhz) {
  const f = Number(frequencyKhz);
  if (!Number.isFinite(f) || f <= 0) return '—';
  const mhz = f / 1000;
  const bands = [
    [1.8, 2.0, '160m'],
    [3.5, 4.0, '80m'],
    [7.0, 7.3, '40m'],
    [10.1, 10.15, '30m'],
    [14.0, 14.35, '20m'],
    [18.068, 18.168, '17m'],
    [21.0, 21.45, '15m'],
    [24.89, 24.99, '12m'],
    [28.0, 29.7, '10m'],
    [50, 54, '6m'],
    [144, 148, '2m'],
    [420, 450, '70cm'],
  ];
  for (const [lo, hi, label] of bands) {
    if (mhz >= lo && mhz <= hi) return label;
  }
  return mhz < 30 ? 'HF' : mhz < 300 ? 'VHF' : 'UHF+';
}

/** Human age of a spot: "3m ago", "2h ago". Returns '—' for bad input. */
export function spotAge(spotTime, now = Date.now()) {
  const t = new Date(spotTime).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = now - t;
  if (diff < 0) return 'future?';
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Short label for a globe marker: "CALL · 20m CW". */
export function spotLabel(spot) {
  const call = String(spot?.activator ?? '');
  const band = bandLabel(spot?.frequencyKhz);
  const mode = String(spot?.mode ?? '');
  return [call, band !== '—' ? band : null, mode || null]
    .filter(Boolean)
    .join(' · ');
}

/** Keep only spots with usable coords, capped for the globe. */
export function plottableSpots(spots, cap = 300) {
  return (Array.isArray(spots) ? spots : [])
    .filter((s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lon))
    .slice(0, cap);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
}
