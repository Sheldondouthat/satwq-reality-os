/**
 * eventFeed model — pure, dependency-free logic for Reality OS F1
 * (cross-layer event synthesis) and F6 (sky anomaly detection).
 *
 * This module has NO imports at all: no Cesium, no DOM, no node: builtins.
 * It is shared by the server provider (server/providers/eventSynthesis.js)
 * and the colocated unit tests, so every rule here is deterministic and
 * testable with fixture data — no network.
 *
 * Sources (all keyless, per the F1/F6 brief):
 *   - HMS smoke polygons (NOAA, daily KML)
 *   - USGS earthquakes (M4.5+ day GeoJSON)
 *   - NHC active storms (CurrentStorms.json)
 *   - OpenSky state vectors (anonymous, rate-limited)
 *
 * FIRMS is deliberately NOT used here: the prod FIRMS_MAP_KEY is
 * NOT-CONFIGURED, so any incident rule that needs fire-hotspot ground truth
 * would degrade 100% of the time. When a FIRMS key exists, a
 * `hotspot-near-*` rule can reuse synthesizeIncidents()'s pattern — see the
 * FIRMS-UPGRADE note in server/providers/eventSynthesis.js.
 */

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Number() coerces null → 0, which would silently turn a missing coordinate
 * or magnitude into a real (0,0) / M0.0 record. Reject null/undefined/''
 * before converting — the same discipline as src/data/adsbLolFallback.js.
 */
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Great-circle distance between two [lat, lon] points in kilometres.
 * Pure spherical law-of-cosines-free haversine; valid for all finite inputs.
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) *
      Math.cos(lat2 * DEG_TO_RAD) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Approximate centroid of a smoke polygon ring as the arithmetic mean of its
 * vertices. Not area-weighted — good enough for proximity correlation and
 * O(n) cheap. Returns null for empty/unusable rings.
 */
export function polygonCentroid(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let sumLon = 0;
  let sumLat = 0;
  let count = 0;
  for (const point of ring) {
    const lon = Number(point?.[0]);
    const lat = Number(point?.[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    sumLon += lon;
    sumLat += lat;
    count++;
  }
  if (count === 0) return null;
  return { lon: sumLon / count, lat: sumLat / count };
}

/** Circular standard deviation of headings in degrees (0–180 scale). */
function headingSpreadDeg(headings) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const h of headings) {
    if (!Number.isFinite(h)) continue;
    const r = h * DEG_TO_RAD;
    sx += Math.cos(r);
    sy += Math.sin(r);
    n++;
  }
  if (n < 2) return 0;
  const resultant = Math.hypot(sx, sy) / n;
  if (resultant >= 1) return 0;
  // Circular stddev; clamp the log argument away from 0.
  return Math.sqrt(-2 * Math.log(Math.max(resultant, 1e-6))) / DEG_TO_RAD;
}

// ---------------------------------------------------------------------------
// F1: input normalization
// ---------------------------------------------------------------------------

/** USGS M4.5+ GeoJSON feature → {id, mag, place, lat, lon, depthKm, timeMs}. */
export function normalizeQuakeFeature(feature) {
  const coords = feature?.geometry?.coordinates;
  const props = feature?.properties ?? {};
  const lon = finiteNumber(coords?.[0]);
  const lat = finiteNumber(coords?.[1]);
  const mag = finiteNumber(props?.mag);
  if (lon === null || lat === null || mag === null) return null;
  return {
    id: String(feature?.id ?? props?.code ?? `quake-${lat.toFixed(2)}-${lon.toFixed(2)}`),
    mag,
    place: typeof props?.place === 'string' ? props.place.slice(0, 120) : 'Unknown location',
    lat,
    lon,
    depthKm: finiteNumber(coords?.[2]),
    timeMs: finiteNumber(props?.time),
  };
}

/**
 * Parsed NHC storm (from parseCycloneStatus in server/providers/cyclones.js)
 * → {id, name, classification, lat, lon, windKt, advisoryNumber}.
 */
export function normalizeStorm(storm) {
  const lon = finiteNumber(storm?.position?.longitude);
  const lat = finiteNumber(storm?.position?.latitude);
  if (lon === null || lat === null) return null;
  return {
    id: String(storm?.id ?? 'storm-unknown'),
    name: typeof storm?.name === 'string' ? storm.name : 'Unnamed',
    classification: typeof storm?.classification === 'string' ? storm.classification : '',
    lat,
    lon,
    windKt: Number.isFinite(Number(storm?.windKt)) ? Number(storm.windKt) : null,
    advisoryNumber: storm?.advisoryNumber ?? null,
  };
}

/**
 * OpenSky state vector (array form) → track record.
 * Indices per the OpenSky /states/all schema:
 *   0 icao24, 1 callsign, 5 longitude, 6 latitude, 7 baro_altitude (m),
 *   8 on_ground, 9 velocity (m/s), 10 true_track (deg),
 *   11 vertical_rate (m/s), 14 squawk, 15 spi.
 */
export function normalizeOpenSkyState(vector) {
  if (!Array.isArray(vector)) return null;
  const lon = finiteNumber(vector[5]);
  const lat = finiteNumber(vector[6]);
  if (lon === null || lat === null) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  const icao24 = String(vector[0] ?? '').trim().toLowerCase();
  if (!icao24) return null;
  const callsign =
    typeof vector[1] === 'string' && vector[1].trim() ? vector[1].trim() : null;
  const squawk =
    typeof vector[14] === 'string' && /^\d{4}$/.test(vector[14].trim())
      ? vector[14].trim()
      : null;
  return {
    icao24,
    callsign,
    squawk,
    lat,
    lon,
    baroAltM: finiteNumber(vector[7]),
    onGround: vector[8] === true,
    speedMps: finiteNumber(vector[9]),
    headingDeg: finiteNumber(vector[10]),
    vertRateMps: finiteNumber(vector[11]),
  };
}

// ---------------------------------------------------------------------------
// F1: traffic density grid
// ---------------------------------------------------------------------------

/** Density cell size in degrees; exported so tests and tuners share it. */
export const DENSITY_CELL_DEG = 2;
/** A cell with at least this many aircraft counts as "elevated" traffic. */
export const DENSITY_ELEVATED_MIN = 10;
/** Cap on density cells (safety against pathological snapshots). */
export const DENSITY_MAX_CELLS = 4000;

/**
 * Bin normalized tracks into a coarse lat/lon grid.
 * @returns {Array<{lat:number, lon:number, count:number}>} cell centers with
 *   count >= DENSITY_ELEVATED_MIN, sorted by count descending.
 */
export function buildTrafficDensity(tracks, cellDeg = DENSITY_CELL_DEG) {
  const cells = new Map();
  for (const t of tracks) {
    if (!t || !Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue;
    const keyLat = Math.floor(t.lat / cellDeg);
    const keyLon = Math.floor(t.lon / cellDeg);
    const key = `${keyLat}:${keyLon}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { lat: (keyLat + 0.5) * cellDeg, lon: (keyLon + 0.5) * cellDeg, count: 0 };
      cells.set(key, cell);
    }
    cell.count++;
  }
  const elevated = [];
  for (const cell of cells.values()) {
    if (cell.count >= DENSITY_ELEVATED_MIN) elevated.push(cell);
    if (elevated.length >= DENSITY_MAX_CELLS) break;
  }
  elevated.sort((a, b) => b.count - a.count);
  return elevated;
}

// ---------------------------------------------------------------------------
// F1: incident synthesis
// ---------------------------------------------------------------------------

export const INCIDENT_RULES = Object.freeze({
  SMOKE_NEAR_TRAFFIC_KM: 150,
  QUAKE_NEAR_SMOKE_KM: 200,
  QUAKE_NEAR_STORM_KM: 500,
  STORM_NEAR_TRAFFIC_KM: 300,
  MAX_INCIDENTS: 40,
});

const SEVERITY_ORDER = Object.freeze({ low: 0, moderate: 1, high: 2, critical: 3 });

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}

function proximityConfidence(km, radiusKm, base) {
  // Closer to the epicenter of the rule radius → higher confidence.
  const closeness = 1 - Math.min(1, km / radiusKm);
  return clampConfidence(base + closeness * (1 - base));
}

/**
 * Synthesize SPACE+TIME cross-layer incidents. Every incident correlates
 * >= 2 independent keyless sources and lists them in `sources`.
 *
 * @param {object} inputs
 * @param {Array<{density:string, ring:Array}>} inputs.smokePolygons HMS polygons
 * @param {Array} inputs.quakes normalized USGS quakes
 * @param {Array} inputs.storms normalized NHC storms
 * @param {Array} inputs.densityCells elevated traffic cells
 * @param {number} inputs.nowMs epoch ms for the `at` timestamp
 * @returns {Array} incident records
 */
export function synthesizeIncidents({
  smokePolygons = [],
  quakes = [],
  storms = [],
  densityCells = [],
  nowMs = Date.now(),
} = {}) {
  const at = new Date(nowMs).toISOString();
  const incidents = [];
  const seen = new Set();
  const push = (incident) => {
    if (!incident || seen.has(incident.id)) return;
    if (incidents.length >= INCIDENT_RULES.MAX_INCIDENTS) return;
    seen.add(incident.id);
    incidents.push(incident);
  };

  // Smoke centroids (moderate/heavy only — light smoke is not incident-worthy).
  const smokeCentroids = [];
  for (const poly of smokePolygons) {
    if (poly?.density !== 'moderate' && poly?.density !== 'heavy') continue;
    const c = polygonCentroid(poly.ring);
    if (c) smokeCentroids.push({ ...c, density: poly.density });
  }

  const nearest = (lat, lon, points) => {
    let best = null;
    for (const p of points) {
      const km = haversineKm(lat, lon, p.lat, p.lon);
      if (!best || km < best.km) best = { ...p, km };
    }
    return best;
  };

  // Rule 1: wildfire smoke near dense air traffic.
  for (const smoke of smokeCentroids) {
    const hit = nearest(smoke.lat, smoke.lon, densityCells);
    if (!hit || hit.km > INCIDENT_RULES.SMOKE_NEAR_TRAFFIC_KM) continue;
    const heavy = smoke.density === 'heavy';
    push({
      id: `smoke-traffic:${smoke.lat.toFixed(2)},${smoke.lon.toFixed(2)}`,
      type: 'smoke-near-traffic',
      title: heavy ? 'Heavy wildfire smoke near dense air traffic' : 'Wildfire smoke near dense air traffic',
      detail:
        `${heavy ? 'Heavy' : 'Moderate'}-density HMS smoke ~${Math.round(hit.km)} km ` +
        `from a traffic cell with ${hit.count} aircraft. Smoke can degrade visibility ` +
        `and force reroutes; watch for diversions.`,
      severity: heavy ? 'high' : 'moderate',
      confidence: proximityConfidence(hit.km, INCIDENT_RULES.SMOKE_NEAR_TRAFFIC_KM, heavy ? 0.55 : 0.45),
      sources: ['hms-smoke', 'opensky'],
      lat: smoke.lat,
      lon: smoke.lon,
      at,
    });
  }

  // Rule 2: earthquake near wildfire smoke (compound hazard).
  for (const quake of quakes) {
    const hit = nearest(quake.lat, quake.lon, smokeCentroids);
    if (!hit || hit.km > INCIDENT_RULES.QUAKE_NEAR_SMOKE_KM) continue;
    const strong = quake.mag >= 6;
    push({
      id: `quake-smoke:${quake.id}`,
      type: 'quake-near-smoke',
      title: `M${quake.mag.toFixed(1)} earthquake near wildfire smoke`,
      detail:
        `M${quake.mag.toFixed(1)} quake (${quake.place}) ~${Math.round(hit.km)} km ` +
        `from ${hit.density}-density smoke. Compound hazard: seismic damage plus ` +
        `smoke-impaired response/visibility.`,
      severity: strong ? 'high' : 'moderate',
      confidence: proximityConfidence(hit.km, INCIDENT_RULES.QUAKE_NEAR_SMOKE_KM, strong ? 0.6 : 0.45),
      sources: ['usgs-quakes', 'hms-smoke'],
      lat: quake.lat,
      lon: quake.lon,
      at,
    });
  }

  // Rule 3: earthquake within a tropical cyclone's sphere of influence.
  for (const quake of quakes) {
    const hit = nearest(quake.lat, quake.lon, storms);
    if (!hit || hit.km > INCIDENT_RULES.QUAKE_NEAR_STORM_KM) continue;
    push({
      id: `quake-storm:${quake.id}:${hit.id}`,
      type: 'quake-near-storm',
      title: `M${quake.mag.toFixed(1)} earthquake within ${hit.name}'s reach`,
      detail:
        `M${quake.mag.toFixed(1)} quake (${quake.place}) ~${Math.round(hit.km)} km ` +
        `from ${hit.name} (${hit.classification || 'tropical system'}). ` +
        `Storm response capacity in the region may be degraded.`,
      severity: quake.mag >= 6 ? 'moderate' : 'low',
      confidence: proximityConfidence(hit.km, INCIDENT_RULES.QUAKE_NEAR_STORM_KM, 0.4),
      sources: ['usgs-quakes', 'nhc-storms'],
      lat: quake.lat,
      lon: quake.lon,
      at,
    });
  }

  // Rule 4: dense air traffic near an active tropical cyclone.
  for (const storm of storms) {
    const hit = nearest(storm.lat, storm.lon, densityCells);
    if (!hit || hit.km > INCIDENT_RULES.STORM_NEAR_TRAFFIC_KM) continue;
    push({
      id: `storm-traffic:${storm.id}`,
      type: 'storm-near-traffic',
      title: `Dense air traffic near ${storm.name}`,
      detail:
        `${storm.name} (${storm.classification || 'tropical system'}` +
        `${storm.windKt != null ? `, ${storm.windKt} kt` : ''}) ~${Math.round(hit.km)} km ` +
        `from a traffic cell with ${hit.count} aircraft. Expect reroutes and delays.`,
      severity: 'moderate',
      confidence: proximityConfidence(hit.km, INCIDENT_RULES.STORM_NEAR_TRAFFIC_KM, 0.45),
      sources: ['nhc-storms', 'opensky'],
      lat: storm.lat,
      lon: storm.lon,
      at,
    });
  }

  incidents.sort(
    (a, b) =>
      SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
      b.confidence - a.confidence,
  );
  return incidents;
}

// ---------------------------------------------------------------------------
// F6: sky anomaly detection
// ---------------------------------------------------------------------------

export const EMERGENCY_SQUAWKS = Object.freeze({
  '7500': 'unlawful interference (hijack)',
  '7600': 'radio failure',
  '7700': 'general emergency',
});

/**
 * Major airports used by the v1 go-around heuristic ("near an airport").
 * Public knowledge; coordinates are reference data, not observed aircraft
 * data. Kept intentionally small (40) — this is a proximity sanity check,
 * not an airport database.
 */
export const MAJOR_AIRPORTS = Object.freeze([
  ['ATL', 33.6407, -84.4277], ['DFW', 32.8998, -97.0403], ['DEN', 39.8561, -104.6737],
  ['ORD', 41.9742, -87.9073], ['LAX', 33.9416, -118.4085], ['JFK', 40.6413, -73.7781],
  ['SFO', 37.6213, -122.379], ['SEA', 47.4502, -122.3088], ['LAS', 36.084, -115.1537],
  ['MCO', 28.4312, -81.3081], ['MIA', 25.7932, -80.2906], ['EWR', 40.6895, -74.1745],
  ['CLT', 35.2144, -80.9473], ['PHX', 33.4373, -112.0078], ['IAH', 29.9844, -95.3414],
  ['BOS', 42.3656, -71.0096], ['MSP', 44.8848, -93.2223], ['DTW', 42.2162, -83.3554],
  ['PHL', 39.8729, -75.2437], ['LGA', 40.7769, -73.874],
  ['LHR', 51.47, -0.4543], ['CDG', 49.0097, 2.5479], ['AMS', 52.3105, 4.7683],
  ['FRA', 50.0379, 8.5622], ['MAD', 40.4983, -3.5676], ['BCN', 41.2974, 2.0785],
  ['FCO', 41.8003, 12.2389], ['ZRH', 47.4647, 8.5492], ['DUB', 53.4214, -6.2701],
  ['NRT', 35.772, 140.3929], ['HND', 35.5494, 139.7798], ['ICN', 37.4691, 126.4505],
  ['SIN', 1.3644, 103.9915], ['HKG', 22.308, 113.9145], ['SYD', -33.9399, 151.1753],
  ['DXB', 25.2532, 55.3657], ['DOH', 25.2731, 51.6081], ['GRU', -23.4356, -46.4731],
  ['MEX', 19.4363, -99.0721], ['YYZ', 43.6777, -79.6248],
]);

export const SKY_ALERT_RULES = Object.freeze({
  HOLDING_MIN_SNAPSHOTS: 3,
  HOLDING_MIN_SPAN_MS: 90_000,
  HOLDING_MAX_SPAN_MS: 600_000,
  HOLDING_RADIUS_KM: 12,
  HOLDING_MAX_SPEED_MPS: 110,
  HOLDING_MAX_ALT_M: 9000,
  HOLDING_MIN_HEADING_SPREAD_DEG: 60,
  GOAROUND_MIN_SNAPSHOTS: 3,
  GOAROUND_DESCENT_MPS: -1.5,
  GOAROUND_CLIMB_MPS: 2.5,
  GOAROUND_MAX_ALT_M: 3000,
  GOAROUND_AIRPORT_KM: 25,
  MAX_ALERTS: 50,
});

function nearestAirportKm(lat, lon) {
  let best = null;
  for (const [code, aLat, aLon] of MAJOR_AIRPORTS) {
    const km = haversineKm(lat, lon, aLat, aLon);
    if (!best || km < best.km) best = { code, km };
  }
  return best;
}

/**
 * Detect sky anomalies from a bounded window of OpenSky snapshots.
 *
 * @param {Array<{atMs:number, tracks:Array}>} snapshots oldest → newest,
 *   tracks are normalizeOpenSkyState() records.
 * @param {object} opts { nowMs }
 * @returns {Array} alert records. Exact squawk hits are factual
 *   (heuristic:false, confidence:1); holding-pattern and go-around are
 *   documented v1 heuristics (heuristic:true, confidence<=0.6).
 */
export function detectSkyAlerts(snapshots, { nowMs = Date.now() } = {}) {
  const at = new Date(nowMs).toISOString();
  const alerts = [];
  const seen = new Set();
  if (!Array.isArray(snapshots) || snapshots.length === 0) return alerts;
  const latest = snapshots[snapshots.length - 1];
  const latestTracks = Array.isArray(latest?.tracks) ? latest.tracks : [];

  const push = (alert) => {
    if (!alert || seen.has(alert.id)) return;
    if (alerts.length >= SKY_ALERT_RULES.MAX_ALERTS) return;
    seen.add(alert.id);
    alerts.push(alert);
  };

  // --- Exact: emergency squawk codes (factual, not heuristic) ---
  for (const t of latestTracks) {
    if (!t || !t.squawk) continue;
    const meaning = EMERGENCY_SQUAWKS[t.squawk];
    if (!meaning) continue;
    push({
      id: `squawk-${t.squawk}:${t.icao24}`,
      kind: `squawk-${t.squawk}`,
      title: `Emergency squawk ${t.squawk} — ${meaning}`,
      detail:
        `${t.callsign ? t.callsign + ' ' : ''}(${t.icao24}) is squawking ${t.squawk}, ` +
        `the ICAO code for ${meaning}. Treat as a real emergency until cleared.`,
      icao24: t.icao24,
      callsign: t.callsign,
      squawk: t.squawk,
      lat: t.lat,
      lon: t.lon,
      at,
      heuristic: false,
      confidence: 1,
    });
  }

  // --- Heuristics: need ≥3 snapshots of the same aircraft ---
  const byIcao = new Map();
  for (const snap of snapshots) {
    if (!snap || !Array.isArray(snap.tracks)) continue;
    for (const t of snap.tracks) {
      if (!t || !t.icao24) continue;
      let entry = byIcao.get(t.icao24);
      if (!entry) {
        entry = { samples: [] };
        byIcao.set(t.icao24, entry);
      }
      entry.samples.push({ atMs: snap.atMs, track: t });
    }
  }

  for (const [icao24, entry] of byIcao) {
    const samples = entry.samples;
    if (samples.length < SKY_ALERT_RULES.HOLDING_MIN_SNAPSHOTS) continue;
    const span = samples[samples.length - 1].atMs - samples[0].atMs;
    if (span < SKY_ALERT_RULES.HOLDING_MIN_SPAN_MS) continue;
    if (span > SKY_ALERT_RULES.HOLDING_MAX_SPAN_MS) continue;
    const cur = samples[samples.length - 1].track;
    if (!cur || cur.onGround) continue;

    // v1 holding-pattern heuristic: slow, low-ish, turning in a small area.
    {
      const mean = samples.reduce(
        (acc, s) => ({ lat: acc.lat + s.track.lat / samples.length, lon: acc.lon + s.track.lon / samples.length }),
        { lat: 0, lon: 0 },
      );
      let maxR = 0;
      let speedSum = 0;
      let speedN = 0;
      const headings = [];
      for (const s of samples) {
        maxR = Math.max(maxR, haversineKm(s.track.lat, s.track.lon, mean.lat, mean.lon));
        if (Number.isFinite(s.track.speedMps)) {
          speedSum += s.track.speedMps;
          speedN++;
        }
        if (Number.isFinite(s.track.headingDeg)) headings.push(s.track.headingDeg);
      }
      const avgSpeed = speedN ? speedSum / speedN : null;
      const spread = headingSpreadDeg(headings);
      const alt = cur.baroAltM;
      if (
        maxR <= SKY_ALERT_RULES.HOLDING_RADIUS_KM &&
        avgSpeed !== null &&
        avgSpeed <= SKY_ALERT_RULES.HOLDING_MAX_SPEED_MPS &&
        (alt === null || alt <= SKY_ALERT_RULES.HOLDING_MAX_ALT_M) &&
        spread >= SKY_ALERT_RULES.HOLDING_MIN_HEADING_SPREAD_DEG
      ) {
        push({
          id: `holding:${icao24}`,
          kind: 'holding-pattern',
          title: `Possible holding pattern — ${cur.callsign ?? icao24}`,
          detail:
            `Heuristic v1: ${samples.length} snapshots over ${Math.round(span / 1000)}s show ` +
            `${cur.callsign ?? icao24} turning (heading spread ~${Math.round(spread)}°) ` +
            `within ${maxR.toFixed(1)} km at ~${Math.round(avgSpeed * 1.94384)} kt. ` +
            `Could be a hold, a training circuit, or maneuvering — verify visually.`,
          icao24,
          callsign: cur.callsign,
          squawk: cur.squawk,
          lat: cur.lat,
          lon: cur.lon,
          at,
          heuristic: true,
          confidence: 0.55,
        });
      }
    }

    // v1 go-around heuristic: descent → climb near an airport, low altitude.
    {
      const first = samples[0].track;
      const last = samples[samples.length - 1].track;
      const v0 = first.vertRateMps;
      const v1 = last.vertRateMps;
      const alt = last.baroAltM;
      if (
        Number.isFinite(v0) &&
        Number.isFinite(v1) &&
        v0 <= SKY_ALERT_RULES.GOAROUND_DESCENT_MPS &&
        v1 >= SKY_ALERT_RULES.GOAROUND_CLIMB_MPS &&
        (alt === null || alt <= SKY_ALERT_RULES.GOAROUND_MAX_ALT_M)
      ) {
        const airport = nearestAirportKm(last.lat, last.lon);
        if (airport && airport.km <= SKY_ALERT_RULES.GOAROUND_AIRPORT_KM) {
          push({
            id: `goaround:${icao24}`,
            kind: 'go-around',
            title: `Possible go-around — ${last.callsign ?? icao24} near ${airport.code}`,
            detail:
              `Heuristic v1: vertical rate flipped from ${v0.toFixed(1)} m/s (descending) ` +
              `to +${v1.toFixed(1)} m/s (climbing) within ${airport.km.toFixed(1)} km of ` +
              `${airport.code} at ${alt !== null ? Math.round(alt * 3.28084) + ' ft' : 'unknown altitude'}. ` +
              `Could be a go-around, a touch-and-go, or noisy ADS-B data.`,
            icao24,
            callsign: last.callsign,
            squawk: last.squawk,
            lat: last.lat,
            lon: last.lon,
            at,
            heuristic: true,
            confidence: 0.5,
          });
        }
      }
    }
  }

  // Exact squawk alerts first (severity of fact), then by confidence.
  alerts.sort((a, b) => {
    const ah = a.heuristic ? 1 : 0;
    const bh = b.heuristic ? 1 : 0;
    return ah - bh || b.confidence - a.confidence;
  });
  return alerts;
}

/** Human label for an incident type (panel use). */
export function incidentTypeLabel(type) {
  switch (type) {
    case 'smoke-near-traffic':
      return 'Smoke × Traffic';
    case 'quake-near-smoke':
      return 'Quake × Smoke';
    case 'quake-near-storm':
      return 'Quake × Storm';
    case 'storm-near-traffic':
      return 'Storm × Traffic';
    default:
      return String(type ?? 'event');
  }
}

/** Human label for a sky-alert kind (panel use). */
export function skyAlertKindLabel(kind) {
  switch (kind) {
    case 'squawk-7500':
      return 'Squawk 7500';
    case 'squawk-7600':
      return 'Squawk 7600';
    case 'squawk-7700':
      return 'Squawk 7700';
    case 'holding-pattern':
      return 'Holding pattern?';
    case 'go-around':
      return 'Go-around?';
    default:
      return String(kind ?? 'alert');
  }
}
