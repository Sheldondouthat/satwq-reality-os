/**
 * Cable-threat correlation — pure spatial-join logic (no Cesium, no DOM,
 * testable in plain Node).
 *
 * In-house join of existing AIS vessel positions × the bundled
 * TeleGeography submarine-cable polylines. Flags vessels reporting
 * <0.5 kn (slow/anchored) within 2 km of a cable route that remain slow
 * and near-stationary for >30 min.
 *
 * PHYSICS HONESTY: this is a proximity heuristic over cooperative
 * broadcast metadata (AIS), not proof of intent. Threats are labeled
 * "loiter-near-cable CANDIDATE" everywhere they surface.
 */

export const CANDIDATE_SPEED_KN = 0.5;
export const CANDIDATE_DIST_M = 2000;
export const POSITION_FRESHNESS_SEC = 1800;
export const LOITER_MIN_MS = 30 * 60_000;
export const LOITER_DISP_M = 500;
const GRID_DEG = 0.5;
const EARTH_R_M = 6_371_000;

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.sqrt(a));
}

/**
 * Flatten cable GeoJSON (MultiLineString features) into segments with a
 * 0.5° grid index for O(1)-ish nearest lookup.
 */
export function buildCableIndex(geojson) {
  const segments = [];
  const grid = new Map();
  const features = Array.isArray(geojson?.features) ? geojson.features : [];

  const cellKey = (lon, lat) =>
    `${Math.floor(lon / GRID_DEG)}:${Math.floor(lat / GRID_DEG)}`;

  const addSegment = (a, b, cableId, cableName) => {
    const idx = segments.length;
    const seg = { a, b, cableId, cableName };
    segments.push(seg);
    const minLon = Math.min(a[0], b[0]);
    const maxLon = Math.max(a[0], b[0]);
    const minLat = Math.min(a[1], b[1]);
    const maxLat = Math.max(a[1], b[1]);
    for (let cx = Math.floor(minLon / GRID_DEG); cx <= Math.floor(maxLon / GRID_DEG); cx += 1) {
      for (let cy = Math.floor(minLat / GRID_DEG); cy <= Math.floor(maxLat / GRID_DEG); cy += 1) {
        const key = `${cx}:${cy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(idx);
      }
    }
  };

  for (const feature of features) {
    const geometry = feature?.geometry;
    if (!geometry || geometry.type !== 'MultiLineString') continue;
    const props = feature?.properties ?? {};
    const cableId = String(props.id ?? props.feature_id ?? 'unknown-cable');
    const cableName = String(props.name ?? cableId);
    for (const line of geometry.coordinates ?? []) {
      for (let i = 0; i + 1 < line.length; i += 1) {
        const a = line[i];
        const b = line[i + 1];
        if (Array.isArray(a) && Array.isArray(b)) addSegment(a, b, cableId, cableName);
      }
    }
  }

  return { segments, grid, cableCount: features.length, cellKey };
}

/** Distance from a point to a segment, in meters (local equirectangular frame). */
export function pointToSegmentMeters(lat, lon, seg) {
  const toRad = Math.PI / 180;
  const lat0 = ((seg.a[1] + seg.b[1]) / 2) * toRad;
  const kx = Math.cos(lat0) * 111_320;
  const ky = 111_320;
  const ax = seg.a[0] * kx;
  const ay = seg.a[1] * ky;
  const bx = seg.b[0] * kx;
  const by = seg.b[1] * ky;
  const px = lon * kx;
  const py = lat * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Nearest cable segment within maxMeters of (lat, lon), or null.
 * The 3×3 cell neighborhood always covers 2 km (cells are 0.5° ≈ 55 km).
 */
export function nearestCable(lat, lon, index, maxMeters = CANDIDATE_DIST_M) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !index) return null;
  const cx = Math.floor(lon / GRID_DEG);
  const cy = Math.floor(lat / GRID_DEG);
  const seen = new Set();
  let best = null;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const bucket = index.grid.get(`${cx + dx}:${cy + dy}`);
      if (!bucket) continue;
      for (const segIdx of bucket) {
        if (seen.has(segIdx)) continue;
        seen.add(segIdx);
        const seg = index.segments[segIdx];
        const distM = pointToSegmentMeters(lat, lon, seg);
        if (distM <= maxMeters && (!best || distM < best.distM)) {
          best = { distM, segment: seg };
        }
      }
    }
  }
  return best;
}

function vesselIsCandidate(vessel, nowMs) {
  const { lat, lon, speed, last_position_epoch } = vessel ?? {};
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (!Number.isFinite(speed) || speed >= CANDIDATE_SPEED_KN) return false;
  const ageSec = nowMs / 1000 - (last_position_epoch ?? 0);
  if (!(ageSec >= 0 && ageSec <= POSITION_FRESHNESS_SEC)) return false;
  return true;
}

/**
 * Persistent slow-near-cable sightings. A sighting becomes a THREAT when
 * the vessel has been observed slow within 2 km for >30 min with ≤500 m
 * total displacement. All outputs are labeled candidates.
 */
export class SightingTracker {
  constructor() {
    this.sightings = new Map(); // mmsi -> sighting
  }

  observe(vessel, nearest, nowMs = Date.now()) {
    const mmsi = String(vessel?.mmsi ?? '');
    if (!mmsi) return null;
    let sighting = this.sightings.get(mmsi);
    if (!sighting) {
      sighting = {
        mmsi,
        name: vessel.name ?? `MMSI ${mmsi}`,
        type: vessel.type ?? '',
        destination: vessel.destination ?? '',
        firstSeenMs: nowMs,
        firstLat: vessel.lat,
        firstLon: vessel.lon,
        lastSeenMs: nowMs,
        lastLat: vessel.lat,
        lastLon: vessel.lon,
        speedKn: vessel.speed,
        count: 0,
        maxDispM: 0,
        nearestCableId: null,
        nearestCableName: null,
        nearestDistM: null,
        nearestSegRef: null,
        corroborated: false,
      };
      this.sightings.set(mmsi, sighting);
    }
    sighting.lastSeenMs = nowMs;
    sighting.lastLat = vessel.lat;
    sighting.lastLon = vessel.lon;
    sighting.speedKn = vessel.speed;
    sighting.count += 1;
    sighting.maxDispM = Math.max(
      sighting.maxDispM,
      haversineMeters(sighting.firstLat, sighting.firstLon, vessel.lat, vessel.lon),
    );
    if (nearest) {
      sighting.nearestCableId = nearest.segment.cableId;
      sighting.nearestCableName = nearest.segment.cableName;
      sighting.nearestDistM = nearest.distM;
      sighting.nearestSegRef = nearest.segment;
    }
    return sighting;
  }

  drop(mmsi) {
    this.sightings.delete(String(mmsi));
  }

  prune(nowMs = Date.now(), maxAgeMs = 4 * 60 * 60_000) {
    for (const [mmsi, s] of this.sightings) {
      if (nowMs - s.lastSeenMs > maxAgeMs) this.sightings.delete(mmsi);
    }
  }

  threats(nowMs = Date.now()) {
    const out = [];
    for (const sighting of this.sightings.values()) {
      const loiterMs = sighting.lastSeenMs - sighting.firstSeenMs;
      if (
        sighting.count >= 2 &&
        loiterMs >= LOITER_MIN_MS &&
        sighting.maxDispM <= LOITER_DISP_M &&
        Number.isFinite(sighting.speedKn) &&
        sighting.speedKn < CANDIDATE_SPEED_KN &&
        sighting.nearestDistM !== null
      ) {
        out.push({
          ...sighting,
          loiterMs,
          verdict: 'loiter-near-cable CANDIDATE',
          note: 'Proximity heuristic over broadcast AIS metadata — not proof of intent.',
        });
      }
    }
    return out;
  }
}

/**
 * Run one join pass: candidate vessels × cable index, updating the tracker.
 * Returns {candidates, threats}.
 */
export function joinPass(vessels, index, tracker, nowMs = Date.now()) {
  const candidates = [];
  const seenMmsi = new Set();
  for (const vessel of vessels ?? []) {
    if (!vesselIsCandidate(vessel, nowMs)) continue;
    const nearest = nearestCable(vessel.lat, vessel.lon, index);
    if (!nearest) continue;
    const sighting = tracker.observe(vessel, nearest, nowMs);
    seenMmsi.add(String(vessel.mmsi));
    candidates.push({ vessel, nearest, sighting });
  }
  // Vessels no longer candidate-eligible drop their sightings (they moved
  // off or sped up — but keep them if simply unseen this pass).
  for (const mmsi of [...tracker.sightings.keys()]) {
    const s = tracker.sightings.get(mmsi);
    if (!seenMmsi.has(mmsi) && nowMs - s.lastSeenMs > 3 * 60 * 60_000) {
      tracker.drop(mmsi);
    }
  }
  return { candidates, threats: tracker.threats(nowMs) };
}
