/** Validate a complete USGS volcano GeoJSON feed before replacing the last good snapshot. */
export function normalizeVolcanoSnapshot(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  const ids = new Set();
  for (const feature of geojson.features) {
    const coordinates = feature?.geometry?.coordinates;
    const properties = feature?.properties;
    if (
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      return null;
    const [lon, lat] = coordinates;
    if (
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180 ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90
    )
      return null;
    const vnum = properties.vnum;
    const stableId =
      vnum == null || vnum === '' ? `volcano-${rows.length + 1}` : String(vnum);
    if (ids.has(stableId)) return null;
    ids.add(stableId);
    rows.push({
      stableId,
      name:
        typeof properties.volcanoName === 'string'
          ? properties.volcanoName
          : 'Unnamed volcano',
      lon,
      lat,
      alertLevel:
        typeof properties.alertLevel === 'string'
          ? properties.alertLevel
          : 'UNASSIGNED',
      colorCode:
        typeof properties.colorCode === 'string'
          ? properties.colorCode.toUpperCase()
          : 'UNASSIGNED',
    });
  }
  return rows;
}
