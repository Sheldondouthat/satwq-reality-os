/**
 * WebXR mode — live data sprites.
 *
 * Fetches the keyless event feeds and turns them into sprites on the inside
 * of the planet: {lon, lat, color, size, label}. Pure mapping functions are
 * tested; the fetch wrapper is fail-soft and injectable.
 */

/** Severity → sprite color. */
export const SEVERITY_COLORS = Object.freeze({
  critical: '#ff5a5a',
  high: '#ffb347',
  moderate: '#9fc2ff',
  low: '#7ddba3',
});

/** Map a /api/events incident → sprite. Null when unmappable. */
export function incidentToSprite(incident) {
  if (!incident || !Number.isFinite(incident.lat) || !Number.isFinite(incident.lon)) return null;
  return {
    lon: incident.lon,
    lat: incident.lat,
    color: SEVERITY_COLORS[incident.severity] || SEVERITY_COLORS.moderate,
    size: incident.severity === 'critical' ? 14 : incident.severity === 'high' ? 10 : 7,
    label: String(incident.title || incident.type || 'incident').slice(0, 80),
  };
}

/** Map a USGS quake feature → sprite. Null when below M4.5 or unmappable. */
export function quakeToSprite(feature) {
  const coords = feature?.geometry?.coordinates;
  const mag = feature?.properties?.mag;
  const lon = coords?.[0];
  const lat = coords?.[1];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(mag) || mag < 4.5)
    return null;
  return {
    lon,
    lat,
    color: mag >= 6 ? SEVERITY_COLORS.critical : mag >= 5.5 ? SEVERITY_COLORS.high : SEVERITY_COLORS.moderate,
    size: Math.min(16, 5 + mag),
    label: `M${mag.toFixed(1)} ${String(feature?.properties?.place || '').slice(0, 60)}`,
  };
}

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch live sprites. Returns [] on any failure — never throws.
 * `fetchImpl` is injectable for tests.
 */
export async function fetchSprites({ fetchImpl = fetchJson, maxSprites = 400 } = {}) {
  const sprites = [];
  const push = (s) => {
    if (s && sprites.length < maxSprites) sprites.push(s);
  };
  try {
    const events = await fetchImpl('/api/events');
    for (const inc of events?.incidents ?? []) push(incidentToSprite(inc));
  } catch {
    /* fail-soft */
  }
  try {
    const quakes = await fetchImpl(
      'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson',
    );
    for (const f of quakes?.features ?? []) push(quakeToSprite(f));
  } catch {
    /* fail-soft */
  }
  return sprites;
}
