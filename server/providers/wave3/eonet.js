/**
 * NASA EONET v3 natural-events provider (keyless).
 *
 * Upstream (VERIFIED live 2026-09-27):
 *   https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30
 * → { events: [{ id, title, categories:[{id,title}], sources:[{id,url}],
 *                geometry: [{ magnitudeValue, magnitudeUnit, date,
 *                             type, coordinates:[lon,lat] }] }] }
 *
 * Physics honesty: geometry points are agency-reported positions (e.g.
 * NOAA NHC storm fixes); polylines connect reported fixes, NOT a forecast
 * or a measured continuous track. Magnitudes are agency values in
 * agency units (kts, km, etc.) — passed through, never converted or
 * re-interpreted. Category membership is EONET's classification.
 *
 * Consumer contract:
 *   GET /api/eonet[?status=open&days=30&category=severeStorms] → JSON
 *   {
 *     fetchedAt, query: { status, days, category }, ttlMs, stale, count,
 *     events: [{
 *       id, title, categories: [ids], sources: [{id, url}],
 *       latest: { t, lon, lat, mag, magUnit } | null,
 *       track: [[lon, lat], ...],   // ≤200 points, reported fixes only
 *       geometryCount
 *     }],
 *     unavailable, reason
 *   }
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, no node: imports, no WASM).
 */

const EONET_BASE = 'https://eonet.gsfc.nasa.gov/api/v3/events';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'SATWQ Reality OS (public NASA EONET context)';
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_TRACK_POINTS = 200;
const MAX_DAYS = 60;

const STATUS_VALUES = new Set(['open', 'closed']);
const CATEGORY_VALUES = new Set([
  'drought',
  'dustHaze',
  'earthquakes',
  'floods',
  'landslides',
  'manmade',
  'seaLakeIce',
  'severeStorms',
  'snow',
  'tempExtremes',
  'volcanoes',
  'waterColor',
  'wildfires',
]);

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': status === 200 ? 'public, max-age=600' : 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function fetchJsonCapped(fetchImpl, url, maxBytes, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`eonet_upstream_${response.status}`), {
        status: 502,
      });
    const text = await response.text();
    if (text.length > maxBytes)
      throw Object.assign(new Error('eonet_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function validPoint(coords) {
  return (
    Array.isArray(coords) &&
    coords.length >= 2 &&
    Number.isFinite(coords[0]) &&
    Number.isFinite(coords[1]) &&
    coords[0] >= -180 &&
    coords[0] <= 180 &&
    coords[1] >= -90 &&
    coords[1] <= 90
  );
}

/**
 * Normalize one EONET event into the consumer contract. Pure function —
 * unit-tested with captured fixtures.
 */
export function normalizeEvent(event) {
  const geometry = Array.isArray(event.geometry) ? event.geometry : [];
  const points = geometry
    .filter((g) => g && validPoint(g.coordinates) && g.date)
    .map((g) => ({
      t: g.date,
      lon: g.coordinates[0],
      lat: g.coordinates[1],
      mag: Number.isFinite(g.magnitudeValue) ? g.magnitudeValue : null,
      magUnit: g.magnitudeUnit || null,
    }))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const latest = points.length ? points[points.length - 1] : null;
  // Downsample long tracks to MAX_TRACK_POINTS, always keeping endpoints.
  let track = points;
  if (points.length > MAX_TRACK_POINTS) {
    const step = (points.length - 1) / (MAX_TRACK_POINTS - 1);
    track = Array.from({ length: MAX_TRACK_POINTS }, (_, i) =>
      points[Math.round(i * step)],
    );
  }
  return {
    id: String(event.id || ''),
    title: String(event.title || ''),
    categories: (Array.isArray(event.categories) ? event.categories : [])
      .map((c) => c?.id)
      .filter(Boolean),
    sources: (Array.isArray(event.sources) ? event.sources : [])
      .map((s) => ({ id: s?.id || null, url: s?.url || null }))
      .filter((s) => s.id || s.url),
    latest,
    track: track.map((p) => [p.lon, p.lat]),
    geometryCount: points.length,
  };
}

/** Parse + validate query params. Returns {status, days, category} or throws {status:400}. */
export function parseQuery(searchParams) {
  const status = searchParams.get('status') || 'open';
  if (!STATUS_VALUES.has(status))
    throw Object.assign(new Error('eonet_bad_status'), { status: 400 });
  let days = 30;
  const rawDays = searchParams.get('days');
  if (rawDays !== null) {
    const d = Number(rawDays);
    if (Number.isFinite(d)) days = Math.min(MAX_DAYS, Math.max(1, Math.floor(d)));
  }
  const category = searchParams.get('category') || null;
  if (category && !CATEGORY_VALUES.has(category))
    throw Object.assign(new Error('eonet_bad_category'), { status: 400 });
  return { status, days, category };
}

export function eonetProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  let cache = null; // { key, at, payload }

  async function getSnapshot(query) {
    const key = `${query.status}|${query.days}|${query.category || ''}`;
    const now = Date.now();
    if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS)
      return { ...cache.payload, stale: false };
    try {
      const params = new URLSearchParams({
        status: query.status,
        days: String(query.days),
      });
      if (query.category) params.set('category', query.category);
      const doc = await fetchJsonCapped(
        fetchImpl,
        `${EONET_BASE}?${params.toString()}`,
        BODY_CAP_BYTES,
        UPSTREAM_TIMEOUT_MS,
      );
      const rawEvents = Array.isArray(doc.events) ? doc.events : [];
      const events = rawEvents
        .map(normalizeEvent)
        .filter((e) => e.id)
        .sort((a, b) => {
          const ta = a.latest?.t || '';
          const tb = b.latest?.t || '';
          return ta < tb ? 1 : ta > tb ? -1 : 0;
        });
      const payload = {
        fetchedAt: now,
        query,
        ttlMs: CACHE_TTL_MS,
        stale: false,
        count: events.length,
        events,
        unavailable: false,
        reason: null,
      };
      cache = { key, at: now, payload };
      return payload;
    } catch (error) {
      if (cache && cache.key === key) return { ...cache.payload, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' });
    let query;
    try {
      query = parseQuery(new URL(req.url, 'http://localhost').searchParams);
    } catch (error) {
      return sendJson(res, 400, { error: 'eonet_bad_request' });
    }
    try {
      sendJson(res, 200, await getSnapshot(query));
    } catch {
      sendJson(res, 502, { error: 'eonet_upstream_unavailable' });
    }
  }

  return {
    name: 'eonet',
    configureServer({ middlewares }) {
      middlewares.use('/api/eonet', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/eonet', handler);
    },
  };
}
