/**
 * NWS alerts — pure data logic (no Cesium, testable in plain Node).
 *
 * Consumes the trimmed /api/nws-alerts snapshot:
 *   {generatedAt, count, withGeometry, alerts:[{id,event,headline,description,
 *    severity,certainty,urgency,effective,expires,onset,senderName,areaDesc,
 *    affectedZones,geometry}]}
 */

export const SEVERITY_ORDER = ['Unknown', 'Minor', 'Moderate', 'Severe', 'Extreme'];

export const SEVERITY_COLORS = {
  Extreme: { r: 1.0, g: 0.15, b: 0.2, a: 0.45 },
  Severe: { r: 1.0, g: 0.35, b: 0.1, a: 0.4 },
  Moderate: { r: 1.0, g: 0.65, b: 0.1, a: 0.35 },
  Minor: { r: 1.0, g: 0.85, b: 0.2, a: 0.3 },
  Unknown: { r: 0.6, g: 0.65, b: 0.75, a: 0.3 },
};

export function severityRank(severity) {
  const i = SEVERITY_ORDER.indexOf(severity);
  return i < 0 ? 0 : i;
}

export function colorForAlert(alert) {
  return SEVERITY_COLORS[alert?.severity] ?? SEVERITY_COLORS.Unknown;
}

export async function fetchNwsAlerts({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/nws-alerts', { cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(`nws_alerts_http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/** Centroid of the first polygon ring — camera target + label anchor. */
export function alertCentroid(alert) {
  const geometry = alert?.geometry;
  if (!geometry) return null;
  const ring = geometry.type === 'Polygon'
    ? geometry.coordinates?.[0]
    : geometry.coordinates?.[0]?.[0];
  if (!Array.isArray(ring) || !ring.length) return null;
  let lon = 0, lat = 0, n = 0;
  for (const pos of ring) {
    if (!Array.isArray(pos)) continue;
    lon += pos[0]; lat += pos[1]; n += 1;
  }
  return n ? { lon: lon / n, lat: lat / n } : null;
}

function ringBbox(ring) {
  let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
  for (const pos of ring) {
    if (!Array.isArray(pos)) continue;
    const [lon, lat] = pos;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return minLon <= maxLon ? { minLon, minLat, maxLon, maxLat } : null;
}

export function alertBbox(alert) {
  const geometry = alert?.geometry;
  if (!geometry) return null;
  const rings = geometry.type === 'Polygon'
    ? geometry.coordinates
    : (geometry.coordinates ?? []).flat();
  let out = null;
  for (const ring of rings) {
    const b = ringBbox(ring ?? []);
    if (!b) continue;
    out = out
      ? {
          minLon: Math.min(out.minLon, b.minLon),
          minLat: Math.min(out.minLat, b.minLat),
          maxLon: Math.max(out.maxLon, b.maxLon),
          maxLat: Math.max(out.maxLat, b.maxLat),
        }
      : b;
  }
  return out;
}

function bboxesOverlap(a, b) {
  return a.minLon <= b.maxLon && a.maxLon >= b.minLon &&
         a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

/**
 * Trivial cross with fire perimeters: mark alerts whose polygon bbox
 * intersects any perimeter bbox. Perimeters are accepted as GeoJSON
 * features ({geometry}) or precomputed {bbox:[minLon,minLat,maxLon,maxLat]}.
 */
export function crossAlertsWithPerimeters(alerts, perimeters) {
  const perimBoxes = (perimeters ?? [])
    .map((p) => {
      if (Array.isArray(p?.bbox) && p.bbox.length === 4) {
        const [minLon, minLat, maxLon, maxLat] = p.bbox;
        return { minLon, minLat, maxLon, maxLat };
      }
      if (p?.geometry) {
        const rings = p.geometry.type === 'Polygon'
          ? p.geometry.coordinates
          : (p.geometry.coordinates ?? []).flat();
        let out = null;
        for (const ring of rings) {
          const b = ringBbox(ring ?? []);
          if (!b) continue;
          out = out
            ? {
                minLon: Math.min(out.minLon, b.minLon),
                minLat: Math.min(out.minLat, b.minLat),
                maxLon: Math.max(out.maxLon, b.maxLon),
                maxLat: Math.max(out.maxLat, b.maxLat),
              }
            : b;
        }
        return out;
      }
      return null;
    })
    .filter(Boolean);
  return (alerts ?? []).map((alert) => {
    const box = alertBbox(alert);
    const fireOverlap = box
      ? perimBoxes.some((pb) => bboxesOverlap(box, pb))
      : false;
    return { alert, fireOverlap };
  });
}

export function filterAlerts(alerts, { minSeverity = 'Unknown', eventIncludes = '' } = {}) {
  const min = severityRank(minSeverity);
  const needle = eventIncludes.trim().toLowerCase();
  return (alerts ?? []).filter((a) => {
    if (severityRank(a?.severity) < min) return false;
    if (needle && !String(a?.event ?? '').toLowerCase().includes(needle)) return false;
    return true;
  });
}

export function sortAlertsBySeverity(alerts) {
  return [...(alerts ?? [])].sort(
    (a, b) => severityRank(b?.severity) - severityRank(a?.severity),
  );
}
