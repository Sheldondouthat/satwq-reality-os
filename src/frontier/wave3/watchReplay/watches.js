/**
 * Watch queries (Wave 3, Track 1c, item 1.11) — condition parser + evaluator.
 *
 * Turns natural-language watch requests into structured conditions, then
 * evaluates them against live data (USGS quakes, water-twin rivers).
 *
 * Supported forms (documented; anything else becomes kind:'custom' which
 * reports needsReview instead of silently misfiring):
 *   "alert me when M7+ within 500 km of Tokyo"
 *   "notify me when the Mississippi at St. Louis floods"
 *
 * All geocoding and data fetching are injected, so evaluation is pure and
 * testable. The NL-query infra (src/services/nlQuery.js) remains the
 * interactive path; watches are the scheduled path.
 */

const QUAKE_RE = /M\s?(\d+(?:\.\d+)?)\s*\+\s*(?:within|in)\s*(\d+(?:\.\d+)?)\s*km\s*(?:of|from)\s*(.+)/i;
const WRAPPER_RE = /^(?:alert me|notify me|watch|tell me|warn me)\s+when\s+/i;
const RIVER_RE = /(.+?)\s+(?:floods?|at flood|reaches flood|hits flood)/i;

const EARTH_R_KM = 6371;
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.sqrt(a));
}

/**
 * Parse a watch request into a condition.
 * @param {string} text raw user text
 * @param {object} riverRegistry [{site, name}] for river-name matching
 * @returns {{kind:'quake',...}|{kind:'river',...}|{kind:'custom',...}}
 */
export function parseWatchQuery(text, { riverRegistry = [] } = {}) {
  const raw = String(text ?? '').trim();
  const body = raw.replace(WRAPPER_RE, '').trim();

  const qm = body.match(QUAKE_RE);
  if (qm) {
    return {
      kind: 'quake',
      minMag: Number(qm[1]),
      radiusKm: Number(qm[2]),
      placeQuery: qm[3].trim(),
      center: null, // resolved at add-time via geocode
      raw,
    };
  }

  const rm = body.match(RIVER_RE);
  if (rm) {
    const stopwords = new Set(['the', 'a', 'an', 'river', 'r', 'at']);
    const tokens = rm[1]
      .trim()
      .toLowerCase()
      .split(/[\s.]+/)
      .filter((t) => t.length > 1 && !stopwords.has(t));
    const hit = riverRegistry.find((r) => {
      const name = r.name.toLowerCase();
      return tokens.length > 0 && tokens.every((t) => name.includes(t));
    });
    if (hit) {
      return { kind: 'river', riverSite: hit.site, riverName: hit.name, raw };
    }
    return { kind: 'river', riverSite: null, riverName: rm[1].trim(), raw };
  }

  return { kind: 'custom', text: raw };
}

/**
 * Resolve a quake watch's place query to coordinates (injected geocoder).
 * Returns the watch with center set, or null when unresolvable.
 */
export async function resolveWatchCenter(watch, { geocode }) {
  if (watch.kind !== 'quake') return watch;
  if (watch.center) return watch;
  const place = await geocode(watch.placeQuery);
  if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return null;
  return { ...watch, center: { lat: place.lat, lon: place.lon, label: place.label ?? watch.placeQuery } };
}

const RIVER_BAND_RANK = { unknown: 0, normal: 1, action: 2, 'minor-flood': 3, 'moderate-flood': 4, 'major-flood': 5 };

/**
 * Evaluate one watch against live data.
 * @param {object} watch resolved watch
 * @param {object} data { quakes: [{mag,lat,lon,place,timeMs}], rivers: [{site,band,name}] }
 * @returns {{fired:boolean, detail:string|null, matched?:object}}
 */
export function evaluateWatch(watch, data = {}) {
  if (!watch || typeof watch !== 'object') return { fired: false, detail: null };

  if (watch.kind === 'quake') {
    const { minMag, radiusKm, center } = watch;
    if (!center || !Number.isFinite(minMag) || !Number.isFinite(radiusKm)) {
      return { fired: false, detail: 'watch not resolved yet' };
    }
    const hits = (data.quakes ?? [])
      .filter((q) => Number(q.mag) >= minMag)
      .map((q) => ({ ...q, distKm: haversineKm(center.lat, center.lon, q.lat, q.lon) }))
      .filter((q) => q.distKm <= radiusKm)
      .sort((a, b) => b.mag - a.mag);
    if (!hits.length) return { fired: false, detail: null };
    const h = hits[0];
    return {
      fired: true,
      detail: `M${h.mag} ${h.place ?? ''} — ${Math.round(h.distKm)} km from ${center.label}`,
      matched: h,
    };
  }

  if (watch.kind === 'river') {
    const river = (data.rivers ?? []).find((r) => r.site === watch.riverSite);
    if (!river) return { fired: false, detail: null };
    const rank = RIVER_BAND_RANK[river.band] ?? 0;
    if (rank >= RIVER_BAND_RANK['minor-flood']) {
      return { fired: true, detail: `${river.name} at ${river.band} (gage ${river.gageFt ?? '?'} ft)`, matched: river };
    }
    return { fired: false, detail: null };
  }

  return { fired: false, detail: 'custom watch — review manually', needsReview: true };
}

export { haversineKm };
