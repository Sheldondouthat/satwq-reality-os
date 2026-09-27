/**
 * Wave 5 — SatNOGS ground-station client model (pure, no Cesium).
 *
 * HONESTY: antenna frequency ranges are station-declared capability, not
 * live measurements; status is derived from observation counts.
 */

/** Station color by status: observed green, scheduled amber, idle gray. */
export function statusColor(status) {
  switch (String(status ?? '')) {
    case 'observed': return '#4dd0a6';
    case 'scheduled': return '#ffb454';
    case 'idle': return '#8a93a6';
    default: return '#55607a';
  }
}

/** Compact "400–460 MHz" antenna range label from Hz endpoints. */
export function antennaRangeLabel(lowHz, highHz) {
  const mhz = (v) => {
    const f = Number(v);
    return Number.isFinite(f) && f > 0 ? f / 1_000_000 : null;
  };
  const lo = mhz(lowHz);
  const hi = mhz(highHz);
  const fmt = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} GHz` : `${v >= 100 ? v.toFixed(1) : v.toFixed(2)} MHz`);
  if (lo != null && hi != null && hi > lo) return `${fmt(lo)}–${fmt(hi)}`;
  if (lo != null) return fmt(lo);
  return '—';
}

/** One-line antenna summary: "UHF 400–460 MHz (Cross Yagi)". */
export function antennaSummary(antenna) {
  const band = String(antenna?.band ?? '') || '—';
  const range = antennaRangeLabel(antenna?.frequencyLowHz, antenna?.frequencyHighHz);
  const type = String(antenna?.antennaTypeName ?? '');
  return `${band} ${range}${type ? ` (${type})` : ''}`;
}

/** Human status line: "observed · 10,624 obs". */
export function stationLine(station) {
  const name = String(station?.name ?? 'unnamed');
  const status = String(station?.status ?? 'unknown');
  const obs = Number.isFinite(Number(station?.observations)) ? Number(station.observations) : 0;
  return `${name} · ${status} · ${obs.toLocaleString('en-US')} obs`;
}

/** Keep only stations with coords, capped for the globe. */
export function plottableStations(stations, cap = 500) {
  return (Array.isArray(stations) ? stations : [])
    .filter((s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng))
    .slice(0, cap);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
