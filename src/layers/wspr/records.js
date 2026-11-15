/**
 * WSPR spot payload → arc descriptors. Pure math and validation — no
 * Cesium, no network — so the whole transform is unit-testable in Node.
 *
 * The payload is the /api/wspr-live envelope (BM4 §3): newest-first
 * spots, each carrying its wspr.rx row `id` untouched. That id is the
 * §7 join key: it is preserved verbatim on every arc descriptor (and,
 * in index.js, on the rendered entity) so one arc on this globe and
 * one row in any other face's feed list trace to the same record.
 */

/**
 * Draw cap for arc entities. The endpoint already caps the payload at
 * 1500 spots (the newest ~2–4 minutes of the firehose); drawing all
 * 1500 polylines is beyond the globe's frame discipline, so the layer
 * draws at most this many, chosen by the deterministic even-stride
 * sample in selectArcCohort — the same cohort rule the buoy layer
 * uses for labels. The cap and the rule live here, never as a silent
 * truncation: buildArcDescriptors reports received vs drawn counts.
 */
export const WSPR_ARC_DRAW_CAP = 600;

/**
 * WSPR dial frequencies (MHz) → band label. Spots transmit ~1.5 kHz
 * above the dial, so a spot belongs to a band when its frequency is
 * within WSPR_BAND_TOLERANCE_MHZ of the dial. Anything else is
 * 'other' rather than a guessed band.
 */
export const WSPR_BAND_TOLERANCE_MHZ = 0.01;
export const WSPR_DIAL_BANDS = Object.freeze([
  Object.freeze({ dialMHz: 0.1367, band: '2200m' }),
  Object.freeze({ dialMHz: 0.4742, band: '630m' }),
  Object.freeze({ dialMHz: 1.8366, band: '160m' }),
  Object.freeze({ dialMHz: 3.5686, band: '80m' }),
  Object.freeze({ dialMHz: 5.2872, band: '60m' }),
  Object.freeze({ dialMHz: 7.0386, band: '40m' }),
  Object.freeze({ dialMHz: 10.1387, band: '30m' }),
  Object.freeze({ dialMHz: 14.0956, band: '20m' }),
  Object.freeze({ dialMHz: 18.1046, band: '17m' }),
  Object.freeze({ dialMHz: 21.0946, band: '15m' }),
  Object.freeze({ dialMHz: 24.9246, band: '12m' }),
  Object.freeze({ dialMHz: 28.1246, band: '10m' }),
  Object.freeze({ dialMHz: 50.293, band: '6m' }),
  Object.freeze({ dialMHz: 144.489, band: '2m' }),
]);

/** Band label for a spot frequency, or 'other' when no dial is close. */
export function bandForFreqMHz(freqMHz) {
  if (typeof freqMHz !== 'number' || !Number.isFinite(freqMHz)) return 'other';
  let best = null;
  let bestDelta = Infinity;
  for (const { dialMHz, band } of WSPR_DIAL_BANDS) {
    const delta = Math.abs(freqMHz - dialMHz);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = band;
    }
  }
  return bestDelta <= WSPR_BAND_TOLERANCE_MHZ ? best : 'other';
}

const validCoord = (lat, lon) =>
  typeof lat === 'number' &&
  Number.isFinite(lat) &&
  typeof lon === 'number' &&
  Number.isFinite(lon) &&
  lat >= -90 &&
  lat <= 90 &&
  lon >= -180 &&
  lon <= 180 &&
  // Mirror the provider's null-island rule: no WSPR station sits at
  // (0, 0) in the Gulf of Guinea; a (0, 0) end is a missing end.
  !(lat === 0 && lon === 0);

/** One payload spot → one trimmed spot record, or null when unusable. */
export function normalizeWsprSpot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.id);
  if (!Number.isFinite(id)) return null;
  const txLat = Number(raw.txLat);
  const txLon = Number(raw.txLon);
  const rxLat = Number(raw.rxLat);
  const rxLon = Number(raw.rxLon);
  if (!validCoord(txLat, txLon) || !validCoord(rxLat, rxLon)) return null;
  const freqMHz = Number(raw.freqMHz);
  const snrDb = Number(raw.snrDb);
  return {
    // The wspr.rx row id, carried untouched — the §7 join key.
    id,
    time: typeof raw.time === 'string' ? raw.time : null,
    txCall: String(raw.txCall ?? '').slice(0, 16),
    txLat,
    txLon,
    rxCall: String(raw.rxCall ?? '').slice(0, 16),
    rxLat,
    rxLon,
    freqMHz: Number.isFinite(freqMHz) && freqMHz > 0 ? freqMHz : null,
    snrDb: Number.isFinite(snrDb) ? snrDb : null,
    drift: Number.isFinite(Number(raw.drift)) ? Number(raw.drift) : null,
    powerDbm: Number.isFinite(Number(raw.powerDbm))
      ? Number(raw.powerDbm)
      : null,
  };
}

/**
 * Validate one /api/wspr-live envelope. Returns null for anything that
 * is not a spot payload (including the endpoint's error envelopes,
 * which carry `error` and no `spots`); the source turns null into a
 * thrown error so the layer keeps its last good arcs instead of
 * rendering an empty lie. The endpoint's own stale/degraded flags,
 * when present, are carried through untouched — they govern the
 * layer's reported state.
 */
export function normalizeWsprPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.error === 'string' && payload.error) return null;
  if (!Array.isArray(payload.spots)) return null;
  const spots = [];
  const seen = new Set();
  for (const raw of payload.spots) {
    const spot = normalizeWsprSpot(raw);
    if (!spot) continue;
    if (seen.has(spot.id)) continue; // newest-first: first copy wins
    seen.add(spot.id);
    spots.push(spot);
  }
  return {
    generatedAt:
      typeof payload.generatedAt === 'string' ? payload.generatedAt : null,
    windowSec: Number.isFinite(Number(payload.windowSec))
      ? Number(payload.windowSec)
      : null,
    count: Number.isFinite(Number(payload.count))
      ? Number(payload.count)
      : spots.length,
    droppedNoCoords: Number.isFinite(Number(payload.droppedNoCoords))
      ? Number(payload.droppedNoCoords)
      : 0,
    stale: payload.stale === true,
    degraded: payload.degraded === true,
    spots,
  };
}

/**
 * Deterministic even-stride cohort (the buoy layer's sampling rule):
 * under the cap, every spot is drawn; over it, the sample strides
 * evenly across the whole payload so the web stays global instead of
 * collapsing onto whichever region was loudest in the newest minute.
 */
export function selectArcCohort(spots, cap = WSPR_ARC_DRAW_CAP) {
  const limit = Math.max(1, Math.floor(cap));
  if (!Array.isArray(spots) || spots.length <= limit) {
    return Array.isArray(spots) ? spots.slice() : [];
  }
  const step = spots.length / limit;
  const picked = [];
  for (let i = 0; i < limit; i++) picked.push(spots[Math.floor(i * step)]);
  return picked;
}

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance between two lat/lon points, in kilometres. */
export function greatCircleKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Polyline subdivisions for an arc of the given length. */
export function arcSegmentCount(distanceKm) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 8;
  return Math.min(48, Math.max(8, Math.round(distanceKm / 200)));
}

/**
 * Arc apex height in metres: 12% of the great-circle distance,
 * floored at 15 km so regional hops still lift off the surface and
 * capped at 650 km so antipodal paths stay in frame.
 */
export function arcPeakHeightM(distanceKm) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 15000;
  return Math.min(650000, Math.max(15000, distanceKm * 1000 * 0.12));
}

const toUnitVector = (lat, lon) => {
  const phi = toRad(lat);
  const lambda = toRad(lon);
  return [
    Math.cos(phi) * Math.cos(lambda),
    Math.cos(phi) * Math.sin(lambda),
    Math.sin(phi),
  ];
};

const toLatLon = ([x, y, z]) => ({
  lat: (Math.asin(Math.max(-1, Math.min(1, z))) * 180) / Math.PI,
  lon: (Math.atan2(y, x) * 180) / Math.PI,
});

/**
 * Great-circle arc from tx to rx as [lon, lat, heightM] triples:
 * spherical interpolation between the endpoints with a sinusoidal
 * altitude bulge peaking at arcPeakHeightM. Endpoints sit on the
 * surface (height 0); the midpoint reaches the peak.
 */
export function greatCircleArcPoints(tx, rx, segments) {
  const distanceKm = greatCircleKm(tx.lat, tx.lon, rx.lat, rx.lon);
  const count = segments ?? arcSegmentCount(distanceKm);
  const peakM = arcPeakHeightM(distanceKm);
  const a = toUnitVector(tx.lat, tx.lon);
  const b = toUnitVector(rx.lat, rx.lon);
  const dot = Math.max(
    -1,
    Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]),
  );
  const omega = Math.acos(dot);
  const points = [];
  if (omega < 1e-9) {
    // Degenerate hop (tx and rx effectively co-located): a short
    // vertical loop reads better than a zero-length line.
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      points.push([tx.lon, tx.lat, Math.sin(Math.PI * t) * peakM]);
    }
    return points;
  }
  const sinOmega = Math.sin(omega);
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const k0 = Math.sin((1 - t) * omega) / sinOmega;
    const k1 = Math.sin(t * omega) / sinOmega;
    const { lat, lon } = toLatLon([
      a[0] * k0 + b[0] * k1,
      a[1] * k0 + b[1] * k1,
      a[2] * k0 + b[2] * k1,
    ]);
    // Endpoints are grounded by construction (sin(π) is not exactly 0
    // in floating point, and an arc must sit on its stations).
    const heightM = t === 0 || t === 1 ? 0 : Math.sin(Math.PI * t) * peakM;
    points.push([lon, lat, heightM]);
  }
  return points;
}

/**
 * Normalized snapshot → render-ready arc descriptors. Each descriptor
 * keeps the spot's wspr.rx id twice over — `spotId` and inside
 * `entityId` — so the rendered entity traces to the same record id on
 * any face (§7).
 */
export function descriptorsForSnapshot(
  snapshot,
  { cap = WSPR_ARC_DRAW_CAP } = {},
) {
  const cohort = selectArcCohort(snapshot.spots, cap);
  const arcs = cohort.map((spot) => ({
    spotId: spot.id,
    entityId: `wspr-arc:${spot.id}`,
    time: spot.time,
    txCall: spot.txCall,
    rxCall: spot.rxCall,
    freqMHz: spot.freqMHz,
    band: bandForFreqMHz(spot.freqMHz),
    snrDb: spot.snrDb,
    distanceKm: greatCircleKm(spot.txLat, spot.txLon, spot.rxLat, spot.rxLon),
    points: greatCircleArcPoints(
      { lat: spot.txLat, lon: spot.txLon },
      { lat: spot.rxLat, lon: spot.rxLon },
    ),
  }));
  return {
    generatedAt: snapshot.generatedAt,
    windowSec: snapshot.windowSec,
    stale: snapshot.stale,
    degraded: snapshot.degraded,
    droppedNoCoords: snapshot.droppedNoCoords,
    received: snapshot.spots.length,
    drawn: arcs.length,
    capped: arcs.length < snapshot.spots.length,
    arcs,
  };
}

/** Raw /api/wspr-live payload → arc descriptors (null when invalid). */
export function buildArcDescriptors(payload, options = {}) {
  const snapshot = normalizeWsprPayload(payload);
  if (!snapshot) return null;
  return descriptorsForSnapshot(snapshot, options);
}
