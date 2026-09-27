/**
 * Wave 3 / Track 2a.4 — SWPC magnetosphere-glow client model (pure).
 *
 * HONESTY: the glow is a Kp-driven VISUALIZATION — a stylized shell whose
 * color/intensity follows the planetary K-index. It is not a measured
 * magnetosphere. The legend states this.
 */

/** Glow color for a Kp value 0..9. */
export function kpColor(kp) {
  if (!Number.isFinite(kp)) return '#8a93a6';
  const stops = [
    [0, [61, 220, 132]], // calm green
    [3, [255, 225, 77]], // unsettled yellow
    [5, [255, 159, 67]], // G1 orange
    [7, [255, 90, 90]], // G3 red
    [9, [200, 60, 220]], // G5 violet
  ];
  const c = Math.max(0, Math.min(9, kp));
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (c >= stops[i][0] && c <= stops[i + 1][0]) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const f = (c - a[0]) / Math.max(1e-9, b[0] - a[0]);
  const rgb = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * f));
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Glow shell radii in metres (Earth mean radius + shell altitude). */
export function glowRadii(kp) {
  const earth = 6_371_000;
  const lift = 120_000 + Math.max(0, Math.min(9, kp ?? 0)) * 55_000; // storms inflate the shell
  return { x: earth + lift, y: earth + lift, z: earth + lift * 0.92 };
}

/** Base alpha: calm is a whisper, storms blaze. */
export function glowAlpha(kp) {
  if (!Number.isFinite(kp)) return 0.05;
  return Math.min(0.5, 0.06 + (kp / 9) * 0.4);
}

/** Pulse period: the shell breathes faster as Kp rises. */
export function glowPulseMs(kp) {
  const c = Math.max(0, Math.min(9, Number.isFinite(kp) ? kp : 0));
  return Math.round(6000 - (c / 9) * 4500); // 6s -> 1.5s
}

export function kpLabel(doc) {
  if (!doc || !Number.isFinite(doc.kp)) return 'Kp n/a';
  const g = doc.gScale && doc.gScale !== 'G0' ? ` ${doc.gScale}` : '';
  return `Kp ${doc.kp}${g}`;
}
