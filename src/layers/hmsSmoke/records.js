/**
 * Parse NOAA HMS smoke-polygon KML into plain records.
 *
 * HMS colors smoke by density via Placemark style names. The live feed
 * serves StyleMap ids with a `_style` suffix and uses `Medium` (not
 * `Moderate`) for the middle density class:
 *   #Smoke_Light_style    → light
 *   #Smoke_Medium_style   → moderate
 *   #Smoke_Heavy_style    → heavy
 * Bare ids (#Smoke_Light etc.) from older/cached files still parse.
 *
 * Parsing is string/regex based (no DOMParser) so the same code runs in
 * Node tests and in the browser. Malformed placemarks (missing or
 * non-numeric coordinates, unknown density, unclosed rings) are skipped —
 * never synthesized.
 */

/** HMS style name → density. `Medium` is HMS's real middle class (the live
 * feed serves `#Smoke_Medium_style` StyleMap ids); `Moderate` is kept for
 * older/cached files. */
export const SMOKE_DENSITY_BY_STYLE = Object.freeze({
  Smoke_Light: 'light',
  Smoke_Medium: 'moderate',
  Smoke_Moderate: 'moderate',
  Smoke_Heavy: 'heavy',
});

const PLACEMARK_RE = /<Placemark\b[\s\S]*?<\/Placemark>/gi;
const STYLE_URL_RE =
  /<styleUrl>\s*#?\s*(Smoke_(?:Light|Medium|Moderate|Heavy))(?:_style)?\s*<\/styleUrl>/i;
const COORDS_RE = /<coordinates>([\s\S]*?)<\/coordinates>/i;

function isFiniteLonLat(lon, lat) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= -180 &&
    lon <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

/**
 * Parse the <coordinates> text of one LinearRing into [[lon,lat],...].
 * Returns null when the ring is unusable: fewer than 4 positions (a KML
 * LinearRing must be closed), or any non-finite/out-of-range pair.
 */
function parseRing(coordinatesText) {
  const ring = [];
  const tokens = String(coordinatesText).trim().split(/\s+/);
  for (const token of tokens) {
    if (!token) continue;
    const parts = token.split(',');
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!isFiniteLonLat(lon, lat)) return null;
    ring.push([lon, lat]);
  }
  return ring.length >= 4 ? ring : null;
}

/**
 * @param {string} xmlString raw KML text.
 * @param {{maxPolygons?:number}} options cap on returned records (default 400).
 * @returns {Array<{density:'light'|'moderate'|'heavy', ring:Array<[number,number]>>}}
 * @throws when the input is not parseable KML at all.
 */
export function parseSmokeKml(xmlString, { maxPolygons = 400 } = {}) {
  if (typeof xmlString !== 'string' || !/<kml[\s>]/i.test(xmlString)) {
    throw new Error('parseSmokeKml: not a KML document');
  }
  const cap = Math.max(0, Math.floor(maxPolygons));
  const records = [];
  let match;
  // PLACEMARK_RE is global: a prior capped run leaves lastIndex mid-string.
  PLACEMARK_RE.lastIndex = 0;
  while ((match = PLACEMARK_RE.exec(xmlString)) && records.length < cap) {
    const body = match[0];
    const styleMatch = STYLE_URL_RE.exec(body);
    const coordsMatch = COORDS_RE.exec(body);
    if (!styleMatch || !coordsMatch) continue; // malformed placemark: skip
    const ring = parseRing(coordsMatch[1]);
    if (!ring) continue; // malformed ring: skip
    records.push({
      density: SMOKE_DENSITY_BY_STYLE[styleMatch[1]],
      ring,
    });
  }
  return records;
}
