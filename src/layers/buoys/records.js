/** Maximum stations rendered — the full NDBC list is ~1.3k. */
export const MAX_BUOY_STATIONS = 600;

/**
 * Parse the NDBC activestations.xml payload without a DOM dependency.
 * Returns null when no usable stations are found (empty or malformed feed).
 */
export function parseBuoyStationsXml(text) {
  if (typeof text !== 'string' || !text.includes('<station')) return null;
  const rows = [];
  const seen = new Set();
  const stationRe = /<station\b([^>]*?)\/?>/g;
  const attrRe = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = stationRe.exec(text)) !== null) {
    if (rows.length >= MAX_BUOY_STATIONS) break;
    const attrs = {};
    let attr;
    while ((attr = attrRe.exec(match[1])) !== null) {
      attrs[attr[1]] = attr[2];
    }
    const id = attrs.id;
    const lat = Number(attrs.lat);
    const lon = Number(attrs.lon);
    if (!id || seen.has(id)) continue;
    if (
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180
    )
      continue;
    seen.add(id);
    rows.push({
      stableId: id,
      id,
      name: attrs.name || id,
      type: attrs.type || '',
      lat,
      lon,
    });
  }
  return rows.length > 0 ? rows : null;
}
