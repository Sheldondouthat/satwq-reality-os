/**
 * Wave 3 / Track 2a.1 — NWIS gauges client model (pure, no Cesium).
 *
 * HONESTY: `anomalyColor` maps the provider's trailing-window z-score —
 * each gauge compared to its OWN recent history. It is NOT a flood-stage
 * or percentile comparison. The legend in index.js states this.
 */

/** Diverging blue -> pale -> red for a z-score. */
export function anomalyColor(z) {
  if (!Number.isFinite(z)) return '#8a93a6'; // no-data gray
  const c = Math.max(-3, Math.min(3, z));
  // interpolate: -3 deep blue, 0 pale slate, +3 red
  const t = (c + 3) / 6;
  const stops = [
    [0.0, [37, 99, 235]], // -3 blue
    [0.5, [203, 213, 225]], // 0 pale
    [1.0, [239, 68, 68]], // +3 red
  ];
  let a = stops[0];
  let b = stops[1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const f = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
  const rgb = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * f));
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Log-magnitude class 0..6 for discharge in ft^3/s. */
export function magnitudeClass(cfs) {
  if (!Number.isFinite(cfs) || cfs <= 0) return -1;
  const cls = Math.floor(Math.log10(cfs));
  return Math.max(0, Math.min(6, cls));
}

/** Pulse period in ms: strong anomalies pulse faster. */
export function pulsePeriodMs(z) {
  const az = Math.abs(Number.isFinite(z) ? z : 0);
  return Math.round(2400 - Math.min(az, 3) * (1600 / 3)); // 2400ms -> 800ms
}

export function formatFlow(cfs) {
  if (!Number.isFinite(cfs)) return '—';
  if (cfs >= 1_000_000) return `${(cfs / 1_000_000).toFixed(2)}M cfs`;
  if (cfs >= 10_000) return `${(cfs / 1000).toFixed(1)}k cfs`;
  if (cfs >= 100) return `${Math.round(cfs)} cfs`;
  return `${cfs.toFixed(1)} cfs`;
}

export function gaugeLabel(g) {
  const parts = [g?.name ?? 'Gauge'];
  if (Number.isFinite(g?.flowCfs)) parts.push(formatFlow(g.flowCfs));
  if (Number.isFinite(g?.flowZ) && (g?.flowN ?? 0) >= 3) {
    parts.push(`z=${g.flowZ >= 0 ? '+' : ''}${g.flowZ.toFixed(1)}`);
  }
  return parts.join(' · ');
}

/** Base point size from magnitude class (bigger rivers, bigger dots). */
export function basePixelSize(gauge) {
  const cls = magnitudeClass(gauge?.flowCfs);
  if (cls < 0) return 5;
  return 5 + cls * 1.6;
}
