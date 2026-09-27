/**
 * Wave 3 / Track 2a.2 — NWPS forecast-ribbon client model (pure, no Cesium).
 *
 * HONESTY: ribbon color encodes the forecast flow TREND (last vs first
 * forecast step) from NOAA's National Water Model. It is a model-output
 * visualization, not an observed flood state. The legend states this.
 */

/** Color for a forecast trend in percent. */
export function trendColor(trendPct) {
  if (!Number.isFinite(trendPct)) return '#8a93a6';
  const t = Math.max(-100, Math.min(100, trendPct)) / 100; // -1..1
  if (t >= 0) {
    // pale -> orange -> red as the rise steepens
    const f = Math.min(1, t * 2);
    const r = Math.round(203 + (239 - 203) * f);
    const g = Math.round(213 - (213 - 68) * f);
    const b = Math.round(225 - (225 - 68) * f);
    return rgb(r, g, b);
  }
  // falling: pale -> teal
  const f = Math.min(1, -t * 2);
  const r = Math.round(203 - (203 - 45) * f);
  const g = Math.round(213 - (213 - 212) * f);
  const b = Math.round(225 - (225 - 191) * f);
  return rgb(r, g, b);
}

function rgb(r, g, b) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

export function formatFlowShort(flow) {
  if (!Number.isFinite(flow)) return '—';
  if (flow >= 1_000_000) return `${(flow / 1_000_000).toFixed(2)}M`;
  if (flow >= 1000) return `${(flow / 1000).toFixed(1)}k`;
  if (flow >= 100) return `${Math.round(flow)}`;
  return flow.toFixed(1);
}

export function trendLabel(trendPct) {
  if (!Number.isFinite(trendPct)) return 'trend n/a';
  const sign = trendPct >= 0 ? '+' : '';
  return `${sign}${trendPct.toFixed(0)}% fcast`;
}

/** Order ribbon nodes upstream->downstream by forecast magnitude (proxy for flow direction). */
export function orderRibbon(nodes) {
  return [...nodes].sort((a, b) => (b.peakFlow ?? 0) - (a.peakFlow ?? 0));
}

/** Mean trend across ribbon nodes (for the chip label). */
export function meanTrend(nodes) {
  const ts = nodes.map((n) => n.trendPct).filter(Number.isFinite);
  if (!ts.length) return null;
  return ts.reduce((a, b) => a + b, 0) / ts.length;
}
