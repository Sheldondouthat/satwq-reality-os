/**
 * Wave 5 — weather-station ticker client model (pure, no Cesium).
 *
 * HONESTY: kind:'forecast' (MET Norway) and kind:'station-index' (IPMA,
 * locations only, no temperatures) are labeled wherever they render.
 * coordApprox stations are pinned to network centroids, not measured
 * positions — the legend says so.
 */

const API = '/api/wxstations';

/** Temperature color ramp: freezing blue -> mild green -> warm amber -> hot red. */
export function tempColor(tempC) {
  if (!Number.isFinite(tempC)) return '#8a93a6';
  if (tempC < 0) return '#4da6ff';
  if (tempC < 10) return '#37c8ab';
  if (tempC < 20) return '#a3d65c';
  if (tempC < 30) return '#ffb454';
  return '#ff5a5a';
}

/** Marker size grows gently with wind speed. */
export function markerSize(windMs) {
  if (!Number.isFinite(windMs)) return 8;
  return Math.min(14, 8 + windMs * 0.4);
}

export function stationLabel(s) {
  const parts = [];
  if (Number.isFinite(s.tempC)) parts.push(`${s.tempC.toFixed(1)}°C`);
  if (Number.isFinite(s.windMs)) parts.push(`${s.windMs.toFixed(1)} m/s`);
  return parts.join(' · ') || '—';
}

export function kindNote(kind) {
  if (kind === 'forecast') return 'forecast, not observed';
  if (kind === 'station-index') return 'location only — no temperature';
  return 'observed';
}

/** Keep only rows with real coordinates; sort obs before index rows. */
export function normalizeStations(stations) {
  const rows = (Array.isArray(stations) ? stations : []).filter(
    (s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lon),
  );
  const rank = (k) => (k === 'obs' ? 0 : k === 'forecast' ? 1 : 2);
  return rows.sort((a, b) => rank(a.kind) - rank(b.kind));
}

export function summarizeSources(sources) {
  return (Array.isArray(sources) ? sources : []).map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    status: s.status,
    count: s.count ?? 0,
  }));
}

export async function fetchWxStations(fetchImpl = fetch) {
  const res = await fetchImpl(API);
  if (!res.ok) throw new Error(`wxstations_http_${res.status}`);
  const doc = await res.json();
  if (!doc || !Array.isArray(doc.stations))
    throw new Error('wxstations_unexpected_shape');
  return {
    stations: normalizeStations(doc.stations),
    sources: summarizeSources(doc.sources),
    generatedAt: doc.generatedAt ?? null,
    stale: doc.stale === true,
    unavailable: doc.unavailable === true,
    reason: doc.reason ?? null,
  };
}
