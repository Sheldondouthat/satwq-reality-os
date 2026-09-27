/**
 * DART tsunami coupling (Wave 3, Track 1c, item 1.9).
 *
 * On an M6.5+ quake near a subduction zone (existing USGS quake feed), this
 * provider answers "which DART buoys matter?" — the coupling rule is pure
 * logic here — and serves live water-column pressure from
 * `https://www.ndbc.noaa.gov/data/realtime2/<id>.dart` (keyless, verified
 * 2026-09-27) plus NWS tsunami ATOM/CAP alert status via
 * `https://api.weather.gov/alerts/active` (keyless, verified 2026-09-27).
 *
 * Route: GET /api/dart-coupling
 *
 * Physics honesty: buoy coordinates in the registry are APPROXIMATE
 * (curated for coupling-distance math, not navigation); NDBC is the
 * authoritative source. The coupling rule is a geometric heuristic
 * (distance + subduction-zone qualification), not a tsunami forecast.
 *
 * Plain fetch + text/JSON parsing only — no WASM, no node:fs. Safe for the
 * Pages Functions registry path.
 */

const USGS_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const NDBC_DART = (id) => `https://www.ndbc.noaa.gov/data/realtime2/${id}.dart`;
const NWS_ALERTS = (event) =>
  `https://api.weather.gov/alerts/active?event=${encodeURIComponent(event)}&status=actual`;

const CACHE_TTL_MS = 10 * 60_000; // refresh at most every 10 minutes
const STALE_MS = 60 * 60_000; // serve stale cache up to 1 hour
const RETRY_COOLDOWN_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
const TEXT_CAP = 2 * 1024 * 1024;
const USER_AGENT =
  'SATWQ-RealityOS-DART/1.0 (public buoy metadata coupling; contact via repo)';

/** Curated DART registry. Positions APPROXIMATE — coupling math only. */
export const DART_REGISTRY = Object.freeze([
  { id: '21401', lat: 42.61, lon: 152.58, name: 'NW Pacific (Kamchatka)' },
  { id: '21413', lat: 30.53, lon: 152.12, name: 'E of Honshu' },
  { id: '21414', lat: 48.93, lon: 178.25, name: 'W Aleutians' },
  { id: '21415', lat: 50.18, lon: 171.85, name: 'W Aleutians (W)' },
  { id: '21418', lat: 38.72, lon: 148.7, name: 'E of Tohoku' },
  { id: '21419', lat: 44.46, lon: 155.74, name: 'Kuril Islands' },
  { id: '23401', lat: 8.2, lon: -110.0, name: 'E Pacific (C. America)' },
  { id: '32401', lat: -19.29, lon: -74.75, name: 'Off Peru' },
  { id: '32402', lat: -26.38, lon: -73.95, name: 'Off N Chile' },
  { id: '32412', lat: -17.98, lon: -86.39, name: 'Off S Peru' },
  { id: '32413', lat: -7.41, lon: -90.53, name: 'Off Ecuador' },
  { id: '46402', lat: 51.07, lon: -164.0, name: 'Gulf of Alaska' },
  { id: '46403', lat: 52.65, lon: -156.94, name: 'Gulf of Alaska (E)' },
  { id: '46404', lat: 45.85, lon: -136.0, name: 'Off Oregon' },
  { id: '46407', lat: 42.68, lon: -128.83, name: 'Off N California' },
  { id: '46408', lat: 48.08, lon: -124.73, name: 'Off Washington' },
  { id: '46409', lat: 55.0, lon: -148.06, name: 'SE Alaska' },
  { id: '46410', lat: 57.63, lon: -143.63, name: 'SE Alaska (E)' },
  { id: '46411', lat: 51.9, lon: -156.03, name: 'Alaska Peninsula' },
  { id: '46412', lat: 48.5, lon: -126.92, name: 'Off Vancouver Island' },
  { id: '51425', lat: 25.01, lon: 183.32 - 360, name: 'S of Aleutians' },
]);

/** Subduction-zone boxes: [minLon, maxLon, minLat, maxLat]. */
export const SUBDUCTION_ZONES = Object.freeze([
  { name: 'Aleutian Trench', box: [-180, -150, 50, 56] },
  { name: 'Kuril-Kamchatka Trench', box: [146, 163, 44, 56] },
  { name: 'Japan Trench', box: [140, 146, 34, 44] },
  { name: 'Cascadia', box: [-126, -122, 40, 49] },
  { name: 'Middle America Trench', box: [-110, -85, 5, 20] },
  { name: 'Peru-Chile Trench', box: [-82, -70, -45, -5] },
  { name: 'Tonga-Kermadec', box: [-180, -172, -38, -15] },
  { name: 'Java-Sunda Trench', box: [95, 120, -12, 8] },
  { name: 'Philippine Trench', box: [126, 133, 5, 20] },
]);

export const MAG_THRESHOLD = 6.5;
export const MAX_DEPTH_KM = 100;
export const BUOY_RADIUS_KM = 3500;
export const MAX_BUOYS_PER_QUAKE = 4;

const EARTH_R_KM = 6371;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.sqrt(a));
}

/** Which subduction zone contains this epicenter, or null. */
export function subductionZoneFor(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const zone of SUBDUCTION_ZONES) {
    const [minLon, maxLon, minLat, maxLat] = zone.box;
    if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat) return zone.name;
  }
  return null;
}

/** Coupling rule: M6.5+, shallow, inside a subduction box. Pure logic. */
export function qualifiesForCoupling({ mag, depthKm, lat, lon }) {
  if (!Number.isFinite(mag) || mag < MAG_THRESHOLD) return null;
  if (!Number.isFinite(depthKm) || depthKm > MAX_DEPTH_KM) return null;
  return subductionZoneFor(lat, lon);
}

/** Nearest DART buoys within radius, distance-ranked. */
export function nearestDartBuoys(lat, lon, { radiusKm = BUOY_RADIUS_KM, limit = MAX_BUOYS_PER_QUAKE } = {}) {
  return DART_REGISTRY.map((b) => ({ ...b, distKm: haversineKm(lat, lon, b.lat, b.lon) }))
    .filter((b) => b.distKm <= radiusKm)
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, limit);
}

/**
 * Parse an NDBC .dart realtime file.
 * Rows: `YYYY MM DD hh mm ss T HEIGHT_m` (T=1 valid). Returns the latest
 * valid reading plus the reading nearest 3h earlier for a plain change
 * figure. No tsunami claim is derived — the numbers are surfaced as data.
 */
export function parseDartText(text, nowMs = Date.now()) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8) continue;
    const [yy, mo, dd, hh, mi, ss, flag, height] = parts;
    if (flag !== '1') continue;
    const h = Number(height);
    if (!Number.isFinite(h)) continue;
    const t = Date.UTC(+yy, +mo - 1, +dd, +hh, +mi, +ss);
    if (!Number.isFinite(t)) continue;
    rows.push({ timeMs: t, waterColumnM: h });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.timeMs - b.timeMs);
  const latest = rows[rows.length - 1];
  // The reading nearest-but-before the 3h mark (walk back from the end).
  let anchor = rows[0];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].timeMs <= latest.timeMs - 3 * 3600_000) { anchor = rows[i]; break; }
  }
  return {
    ...latest,
    change3hM: latest.waterColumnM - anchor.waterColumnM,
    ageMs: nowMs - latest.timeMs,
  };
}

export function normalizeUsgsFeatures(payload) {
  const features = payload?.features;
  if (!Array.isArray(features)) return null;
  const out = [];
  for (const f of features) {
    const p = f?.properties ?? {};
    const coords = f?.geometry?.coordinates ?? [];
    if (p.mag == null) continue; // Number(null) === 0 would fake an M0 event
    const mag = Number(p.mag);
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    const depthKm = Number(coords[2]);
    if (!Number.isFinite(mag) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      id: String(p.ids ?? p.code ?? f.id ?? ''),
      mag,
      place: String(p.place ?? 'Unknown location'),
      timeMs: Number(p.time),
      lat,
      lon,
      depthKm: Number.isFinite(depthKm) ? depthKm : null,
    });
  }
  return out;
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function dartCouplingProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  maxBuoysPerQuake = MAX_BUOYS_PER_QUAKE,
} = {}) {
  let cache = null; // { quakes, fetchedAt }
  let operation = null;
  let attemptedAt = -Infinity;

  async function upstreamText(url, signal, accept) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`upstream_http_${response.status}`);
    }
    const text = await response.text();
    signal.throwIfAborted();
    if (text.length > TEXT_CAP) throw new Error('upstream_too_large');
    return text;
  }

  async function fetchBuoy(buoy, signal) {
    try {
      const text = await upstreamText(NDBC_DART(buoy.id), signal, 'text/plain');
      const reading = parseDartText(text, now());
      if (!reading) return { ...buoy, distKm: buoy.distKm, status: 'no_reading' };
      const { distKm: _d, ...rest } = buoy;
      return { ...rest, distKm: buoy.distKm, status: 'live', ...reading };
    } catch (error) {
      return { id: buoy.id, name: buoy.name, lat: buoy.lat, lon: buoy.lon, distKm: buoy.distKm, status: 'unreachable', error: error?.message };
    }
  }

  async function fetchTsunamiAlerts(signal) {
    const events = ['Tsunami Warning', 'Tsunami Advisory', 'Tsunami Watch', 'Tsunami Statement'];
    const settled = await Promise.allSettled(
      events.map(async (event) => {
        const text = await upstreamText(NWS_ALERTS(event), signal, 'application/geo+json');
        const payload = JSON.parse(text);
        return (payload.features ?? []).map((f) => ({
          event,
          headline: f?.properties?.headline ?? event,
          area: f?.properties?.areaDesc ?? null,
          severity: f?.properties?.severity ?? null,
          effective: f?.properties?.effective ?? null,
          url: f?.id ?? null,
        }));
      }),
    );
    const alerts = [];
    for (const s of settled) if (s.status === 'fulfilled') alerts.push(...s.value);
    return alerts;
  }

  async function refresh(signal) {
    const usgsText = await upstreamText(USGS_FEED, signal, 'application/geo+json');
    const quakes = normalizeUsgsFeatures(JSON.parse(usgsText));
    if (!quakes) throw new Error('usgs_invalid_json');
    const tsunamiAlerts = await fetchTsunamiAlerts(signal);
    const coupled = [];
    for (const q of quakes) {
      const zone = qualifiesForCoupling(q);
      if (!zone) continue;
      const buoys = nearestDartBuoys(q.lat, q.lon, { limit: maxBuoysPerQuake });
      const buoyReadings = await Promise.all(buoys.map((b) => fetchBuoy(b, signal)));
      signal.throwIfAborted();
      coupled.push({ ...q, subductionZone: zone, buoys: buoyReadings, tsunamiAlerts });
    }
    cache = { quakes: coupled, fetchedAt: now() };
    return cache;
  }

  async function acquire(signal) {
    signal.throwIfAborted();
    if (cache && now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
    if (operation?.controller.signal.aborted) operation = null;
    if (!operation) {
      if (now() - attemptedAt < RETRY_COOLDOWN_MS) throw new Error('dart_retry_later');
      attemptedAt = now();
      const controller = new AbortController();
      const owned = { controller, waiters: 0 };
      const timer = setTimeout(() => controller.abort(), timeoutMs * 2 + 5000);
      owned.promise = refresh(controller.signal).finally(() => {
        clearTimeout(timer);
        if (operation === owned) operation = null;
      });
      operation = owned;
    }
    const owned = operation;
    owned.waiters++;
    try {
      return await owned.promise;
    } finally {
      if (--owned.waiters === 0 && operation === owned) owned.controller.abort();
    }
  }

  function describe(value, { stale = false, reason = null } = {}) {
    return {
      schemaVersion: 1,
      source: 'USGS earthquake feed + NDBC DART realtime + NWS tsunami alerts, via local proxy',
      attribution:
        'Quakes: USGS. Buoy water-column data: NOAA NDBC (buoy positions ' +
        'approximate in coupling registry; NDBC authoritative). Tsunami alerts: NWS.',
      honesty:
        'Coupling rule is a geometric heuristic (M6.5+, depth ≤100 km, inside ' +
        'a subduction-zone box, nearest buoys within 3500 km). It is NOT a ' +
        'tsunami forecast.',
      fetchedAt: value?.fetchedAt ?? null,
      stale,
      unavailable: !value,
      reason,
      quakes: value?.quakes ?? [],
    };
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      sendJson(res, value, status);
    };
    try {
      if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
      try {
        json(200, describe(await acquire(controller.signal)));
      } catch (error) {
        const usable = cache && now() - cache.fetchedAt <= STALE_MS;
        json(
          200,
          usable
            ? describe(cache, { stale: true, reason: 'Upstream unreachable; showing last good sweep.' })
            : describe(null, { reason: 'USGS/NDBC/NWS unreachable and no cached sweep exists.' }),
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'dart-coupling',
    configureServer({ middlewares }) {
      middlewares.use('/api/dart-coupling', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/dart-coupling', handler);
    },
  };
}
