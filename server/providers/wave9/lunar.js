/**
 * Wave 9 — Lunar ephemeris — GET /api/moon (R2-21).
 *
 * Pure computed geometry over the repo's low-precision lunar ephemeris
 * (src/layers/moon/model.js, simplified Meeus/Schlyter — server-side import
 * is an established pattern: wave6/tides.js imports it for king-tides).
 * Zero upstream API cost, zero subrequests.
 *
 * Query:
 *   ?date=<ISO or YYYY-MM-DD>  default = now
 *   ?lat=<deg>&lon=<deg>       optional — adds moonrise/moonset for the
 *                              observer (both required together)
 *   ?next=<1..12>              upcoming canonical phase events, default 8
 *
 * Edge notes (main 2ec4053 precedent): no node: imports, no WASM,
 * redirect:'follow' only. This provider performs NO fetches at all.
 */

import {
  moonPhase,
  moonDistanceKm,
  moonPosition,
  moonRaDec,
  moonGmstDeg,
} from '../../../src/layers/moon/model.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const EARTH_RADIUS_KM = 6378.14;
/** Refraction-adjusted geometric horizon for rise/set events. */
const HORIZON_ALT_DEG = -0.583;
/** Computed perigean threshold: bottom ~15% of the model range (tides.js precedent). */
const PERIGEAN_KM = 370000;
const DAY_MS = 86400000;

const LUNAR_HONESTY = {
  source: 'computed',
  computation:
    'COMPUTED GEOMETRY — not an observation. Phase, illumination, distance, rise/set, sub-lunar point and upcoming events derive from the repo low-precision lunar ephemeris (src/layers/moon/model.js, simplified Meeus/Schlyter algorithm).',
  accuracy:
    'Phase timing ±~0.5 day; perigee timing ±~1 day; illumination within a few percent; sub-lunar point ~0.1–0.3°.',
  riseSet:
    'Moonrise/moonset are topocentric altitudes corrected for lunar parallax (asin(R/dist)); the event is defined at the refracted horizon −0.583°. Accuracy ±~5–15 min at mid-latitudes. A day with no crossing reads moonrise/moonset null with a reason — never synthesized (polar regions can skip events).',
  perigean:
    '"perigean" = computed distance < 370,000 km (bottom ~15% of the model range). It is NOT a supermoon claim.',
  upcoming:
    'Upcoming events are the astronomical instants (elongation extrema for New/Full, 90° elongation crossings for quarters) of the same low-precision model — the same ±~0.5d honesty applies.'
};

/** numOrNull with the Number('')===0 trap guarded (provider standing rule). */
function numOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function parseLunarQuery(req) {
  const url = new URL(req.url, 'http://localhost');
  const dateParam = url.searchParams.get('date');
  let dateMs = Date.now();
  if (dateParam !== null) {
    const t = Date.parse(dateParam);
    if (!Number.isFinite(t)) badRequest(`invalid date: ${dateParam}`);
    dateMs = t;
  }
  const latParam = url.searchParams.get('lat');
  const lonParam = url.searchParams.get('lon');
  let lat = null;
  let lon = null;
  if (latParam !== null || lonParam !== null) {
    lat = numOrNull(latParam);
    lon = numOrNull(lonParam);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      badRequest('lat and lon must both be valid degrees (|lat|<=90, |lon|<=180)');
  }
  let next = 8;
  const nextParam = url.searchParams.get('next');
  if (nextParam !== null) {
    const n = Number(nextParam);
    if (!Number.isInteger(n) || n < 1 || n > 12)
      badRequest('next must be an integer 1..12');
    next = n;
  }
  return { dateMs, lat, lon, next };
}

function norm180(deg) {
  return ((deg + 540) % 360) - 180;
}

/**
 * Topocentric lunar altitude (degrees) for an observer, corrected for
 * lunar parallax: alt_topo ≈ alt_geo − p·sin(alt_geo),
 * p = asin(R_earth / distanceKm).
 */
export function topocentricAltitudeDeg(dateMs, latDeg, lonDeg) {
  const date = new Date(dateMs);
  const { ra, dec } = moonRaDec(date);
  const lst = moonGmstDeg(date) + lonDeg;
  const hourAngleDeg = norm180(lst - ra);
  const latR = latDeg * RAD;
  const decR = dec * RAD;
  const sinAlt =
    Math.sin(decR) * Math.sin(latR) +
    Math.cos(decR) * Math.cos(latR) * Math.cos(hourAngleDeg * RAD);
  const altGeo = Math.asin(Math.min(1, Math.max(-1, sinAlt))) * DEG;
  const parallaxDeg = Math.asin(EARTH_RADIUS_KM / moonDistanceKm(date)) * DEG;
  return altGeo - parallaxDeg * Math.sin(altGeo * RAD);
}

function scanCrossings(dayStartMs, latDeg, lonDeg) {
  const stepMs = 5 * 60 * 1000;
  const scanStart = dayStartMs - 6 * 3600 * 1000;
  const scanEnd = dayStartMs + 30 * 3600 * 1000;
  const dayEnd = dayStartMs + DAY_MS;
  const events = [];
  let prevT = scanStart;
  let prevAlt = topocentricAltitudeDeg(prevT, latDeg, lonDeg);
  for (let t = scanStart + stepMs; t <= scanEnd; t += stepMs) {
    const alt = topocentricAltitudeDeg(t, latDeg, lonDeg);
    const wasBelow = prevAlt < HORIZON_ALT_DEG;
    const isBelow = alt < HORIZON_ALT_DEG;
    if (wasBelow !== isBelow && alt !== prevAlt) {
      const frac = (HORIZON_ALT_DEG - prevAlt) / (alt - prevAlt);
      const crossT = prevT + frac * stepMs;
      if (crossT >= dayStartMs && crossT < dayEnd) {
        events.push({
          type: wasBelow && !isBelow ? 'moonrise' : 'moonset',
          time: new Date(crossT).toISOString(),
        });
      }
    }
    prevT = t;
    prevAlt = alt;
  }
  return events;
}

/** Moonrise/moonset for the UTC calendar day containing dateMs (almanac semantics). */
export function findRiseSet(dateMs, latDeg, lonDeg) {
  const dayStartMs = Math.floor(dateMs / DAY_MS) * DAY_MS;
  const events = scanCrossings(dayStartMs, latDeg, lonDeg);
  const moonrise = events.find((e) => e.type === 'moonrise')?.time ?? null;
  const moonset = events.find((e) => e.type === 'moonset')?.time ?? null;
  const reason =
    events.length === 0 ? 'no crossing this UTC day — circumpolar or below-horizon all day' : null;
  return { moonrise, moonset, events, reason };
}

/**
 * Next `count` canonical phase events (New/First/Full/Last) after dateMs.
 *
 * Detects the astronomical instants, NOT phase-name transitions (the name
 * model bins 45° of elongation per name, so transitions fire ~1.8d before the
 * true quarter — caught by the independent python cross-check, 2026-10-03):
 *   - New Moon  = local minimum of sun–moon elongation
 *   - Full Moon = local maximum of elongation
 *   - First/Last Quarter = 90° elongation crossings (waxing / waning)
 * Extrema are refined by dense sampling; crossings by linear interpolation.
 */
export function upcomingPhases(dateMs, count) {
  const stepMs = 6 * 3600 * 1000;
  const samples = [];
  for (let t = dateMs - stepMs; t < dateMs + 40 * DAY_MS; t += stepMs) {
    const p = moonPhase(new Date(t));
    samples.push({ t, elong: p.elongationDeg, waxing: p.waxing });
  }
  const refine = (centerMs, mode) => {
    let best = centerMs;
    let bestV = mode === 'min' ? Infinity : -Infinity;
    for (let k = -24; k <= 24; k++) {
      const t = centerMs + (k * stepMs) / 24;
      const v = moonPhase(new Date(t)).elongationDeg;
      if ((mode === 'min' && v < bestV) || (mode === 'max' && v > bestV)) {
        bestV = v;
        best = t;
      }
    }
    return best;
  };
  const events = [];
  for (let i = 1; i < samples.length - 1; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const c = samples[i + 1];
    if (a.elong > b.elong && b.elong <= c.elong && b.elong < 30) {
      events.push({ type: 'New Moon', ms: refine(b.t, 'min') });
    } else if (a.elong < b.elong && b.elong >= c.elong && b.elong > 150) {
      events.push({ type: 'Full Moon', ms: refine(b.t, 'max') });
    }
    for (const [s0, s1] of [[a, b], [b, c]]) {
      if ((s0.elong - 90) * (s1.elong - 90) < 0) {
        const frac = (90 - s0.elong) / (s1.elong - s0.elong);
        events.push({
          type: s0.waxing ? 'First Quarter' : 'Last Quarter',
          ms: s0.t + frac * stepMs,
        });
      }
    }
  }
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (e.ms <= dateMs) continue;
    const key = `${e.type}@${Math.round(e.ms / 3600000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const distKm = moonDistanceKm(new Date(e.ms));
    out.push({
      type: e.type,
      date: new Date(e.ms).toISOString(),
      daysAway: Math.round(((e.ms - dateMs) / DAY_MS) * 10) / 10,
      distanceKm: Math.round(distKm),
      perigean: distKm < PERIGEAN_KM,
    });
    if (out.length >= count) break;
  }
  return out;
}

export function getLunarSnapshot({ dateMs, lat, lon, next }) {
  const date = new Date(dateMs);
  const phase = moonPhase(date);
  const distKm = moonDistanceKm(date);
  const sub = moonPosition(date);
  const snapshot = {
    date: date.toISOString(),
    phase: {
      name: phase.name,
      illumination: Math.round(phase.illumination * 1000) / 1000,
      elongationDeg: Math.round(phase.elongationDeg * 10) / 10,
      waxing: phase.waxing,
    },
    distanceKm: Math.round(distKm),
    perigean: distKm < PERIGEAN_KM,
    subLunar: {
      lat: Math.round(sub.lat * 100) / 100,
      lon: Math.round(sub.lon * 100) / 100,
    },
    upcoming: upcomingPhases(dateMs, next),
    source: 'computed',
    generatedAt: new Date().toISOString(),
  };
  if (lat !== null && lon !== null) {
    const rs = findRiseSet(dateMs, lat, lon);
    snapshot.observer = { lat, lon };
    snapshot.riseSet = rs;
  }
  snapshot.honesty = LUNAR_HONESTY;
  return snapshot;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=3600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the lunar ephemeris proxy. Mirrors the wave-6/9 provider shape. */
export function lunarProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const query = parseLunarQuery(req);
      sendJson(res, 200, getLunarSnapshot(query));
    } catch (error) {
      if (error?.status === 400)
        return sendJson(
          res,
          400,
          { error: 'lunar_bad_request', detail: error?.message ?? 'unknown' },
          'no-store',
        );
      sendJson(
        res,
        500,
        { error: 'lunar_unavailable', detail: error?.message ?? 'unknown' },
        'no-store',
      );
    }
  }

  return {
    name: 'lunar',
    configureServer({ middlewares }) {
      middlewares.use('/api/moon', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/moon', handler);
    },
  };
}

export const _lunarInternals = {
  LUNAR_HONESTY,
  topocentricAltitudeDeg,
  findRiseSet,
  upcomingPhases,
  getLunarSnapshot,
  parseLunarQuery,
};
