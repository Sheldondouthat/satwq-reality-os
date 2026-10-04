/**
 * Wave 5 — global quake aggregation client model (pure, no Cesium).
 *
 * The /api/quakes snapshot carries normalized quakes:
 * {id, lat, lon, depthKm, mag, place, time, sources:[usgs|jma|bmkg|geonet|emsc]}.
 * Everything in this file is deterministic math/formatting so it stays
 * testable in plain Node; Cesium lives ONLY in index.js.
 */

/** Fetch the aggregated quake snapshot. Returns the parsed payload or throws. */
export async function fetchQuakes({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/quakes', { cache: 'no-store' });
  if (!response.ok) throw new Error(`quakes_http_${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.quakes)) throw new Error('quakes_bad_payload');
  return payload;
}

/** Point color by magnitude: green <4 → yellow <5 → orange <6 → red 6+ → magenta 7+. */
export function magColor(mag) {
  if (!Number.isFinite(mag)) return '#8a93a6';
  if (mag < 4) return '#4dd07d';
  if (mag < 5) return '#ffd54d';
  if (mag < 6) return '#ff9f43';
  if (mag < 7) return '#ff5a5a';
  return '#c44dff';
}

/** Point pixel size by magnitude: 6px at M3, growing ~2.4px per unit, capped at 26px. */
export function magSize(mag) {
  if (!Number.isFinite(mag)) return 6;
  return Math.min(26, Math.max(6, 6 + (mag - 3) * 2.4));
}

/** Depth band label (matches the layer's depth legend). */
export function depthBand(depthKm) {
  if (!Number.isFinite(depthKm)) return 'unknown';
  if (depthKm < 70) return 'shallow (<70 km)';
  if (depthKm < 300) return 'intermediate (70–300 km)';
  return 'deep (>300 km)';
}

/** Short human label for a quake point: "M6.5 · Southern Alaska". */
export function quakeLabel(quake) {
  const mag = Number.isFinite(quake?.mag) ? `M${quake.mag.toFixed(1)}` : 'M?';
  const place = quake?.place ? ` · ${quake.place}` : '';
  return `${mag}${place}`.slice(0, 120);
}

/** Relative age string: "12m ago", "3h ago", "2d ago". */
export function quakeAge(timeIso, now = Date.now()) {
  const t = Date.parse(timeIso);
  if (!Number.isFinite(t)) return 'age n/a';
  const diff = now - t;
  if (diff < 0) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Source attribution short names for the dock status line. */
export const SOURCE_LABELS = {
  usgs: 'USGS',
  jma: 'JMA',
  bmkg: 'BMKG',
  geonet: 'GeoNet',
  emsc: 'EMSC',
};

/** "USGS+JMA · 3 sources" style summary of a quake's source keys. */
export function sourcesSummary(keys) {
  const labels = (Array.isArray(keys) ? keys : [])
    .map((k) => SOURCE_LABELS[k] ?? k)
    .filter(Boolean);
  if (!labels.length) return 'unknown source';
  return labels.join(' + ');
}

/** Sort quakes by magnitude descending, then recency. */
export function sortQuakesByMag(quakes) {
  return [...quakes].sort((a, b) => {
    const d = (b.mag ?? -9) - (a.mag ?? -9);
    if (d !== 0) return d;
    return Date.parse(b.time ?? 0) - Date.parse(a.time ?? 0);
  });
}

/** Escape user-controlled strings for HTML description fields. */
export function escapeHtml(s) {
  return String(s).replace(
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
