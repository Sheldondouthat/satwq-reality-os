/**
 * Wave 7 — MBTA (Boston) live vehicle positions, normalized JSON layer.
 *
 * #162 MBTA VehiclePositions  https://cdn.mbta.com/realtime/VehiclePositions.pb
 * #58 wave C
 *
 * WHY THE JSON API, NOT THE PROTOBUF: the catalog feed is GTFS-RT protobuf
 * (.pb, ~37 KB, ~10 s cadence). Decoding protobuf at the edge means a WASM
 * or hand-rolled decoder — both disallowed here (no WASM, no node: imports).
 * The MBTA v3 JSON:API endpoint below is the same live feed rendered as
 * JSON:API, keyless for anonymous use (MBTA rate-limits anonymous callers;
 * a free API key raises the limit, this provider caches to stay under it).
 * The raw protobuf bytes remain available untouched at /api/transit via the
 * transitProxy (registered feed id 'mbta' in src/data/transitFeeds.js) —
 * this provider is the normalized-JSON sibling, not a replacement.
 *
 * Routes:
 *   GET /api/mbta            → all live vehicles (paged, capped)
 *   GET /api/mbta?route=<id> → vehicles on one route (id is [A-Za-z0-9-_.], rejected otherwise)
 *
 * NOTE: this provider deliberately does NOT mount /api/transit — that route
 * is already owned by transitProxy (raw GTFS-RT passthrough). /api/mbta is
 * the normalized layer for the same agency.
 *
 * Upstream: https://api-v3.mbta.com/vehicles?include=route
 * (JSON:API; VERIFIED live 2026-09-27 — keyless GET returned the documented
 *  JSON:API envelope. The build VM is throttled on api-v3.mbta.com
 *  (curl 000 on 2026-09-27), so fixture shapes below are synthetic but
 *  documented-shape-faithful; a Worker probe should confirm field names.)
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 *
 * Reachability note (2026-09-27): api-v3.mbta.com returned curl 000 from
 * the build VM — marked VM-throttled, needs Worker probe. No redirect
 * behavior could be verified, so no "verified non-redirecting" claim is
 * made. cdn.mbta.com (the protobuf host) was not probed.
 */

const UPSTREAM_BASE = 'https://api-v3.mbta.com/vehicles';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 30_000;
const MAX_VEHICLES = 500;
const USER_AGENT = 'Gods Eye View (MBTA v3 JSON API aggregation)';

/** MBTA v3 current_status enum → human label. */
const STATUS_LABELS = {
  INCOMING_AT: 'Incoming',
  STOPPED_AT: 'Stopped',
  IN_TRANSIT_TO: 'In transit',
};

const ROUTE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

let cache = null; // {at, key, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampLatLon(lat, lon) {
  if (!isFiniteNum(lat) || !isFiniteNum(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function roundNum(value, decimals = 5) {
  if (!isFiniteNum(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function pickString(...candidates) {
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '') return String(c).trim();
  }
  return '';
}

function parseIso(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number'
    ? (value < 1e12 ? value * 1000 : value)
    : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Build a route-id → display-name map from a JSON:API `included` array. */
function routeNameIndex(included) {
  const index = new Map();
  for (const item of Array.isArray(included) ? included : []) {
    if (!item || typeof item !== 'object' || item.type !== 'route') continue;
    const id = pickString(item.id);
    if (!id) continue;
    const attrs = item.attributes ?? {};
    index.set(id, pickString(attrs.long_name, attrs.short_name, id));
  }
  return index;
}

/**
 * Normalize one JSON:API vehicle resource.
 * Documented shape: {id, type:'vehicle', attributes:{bearing,
 * current_status, current_stop_sequence, direction_id, label, latitude,
 * longitude, occupancy_status, speed, updated_at}, relationships:{route,
 * stop, trip}}.
 */
function normalizeVehicle(resource, routeNames) {
  if (!resource || typeof resource !== 'object') return null;
  const attrs = resource.attributes ?? {};
  const rels = resource.relationships ?? {};
  // NOTE: Number(null) === 0, so nulls must be screened before coercion —
  // otherwise a coordless vehicle lands on Null Island instead of being dropped.
  const lat = attrs.latitude == null || attrs.latitude === '' ? null : Number(attrs.latitude);
  const lon = attrs.longitude == null || attrs.longitude === '' ? null : Number(attrs.longitude);
  const ll = lat != null && lon != null ? clampLatLon(lat, lon) : null;
  if (!ll) return null;
  const routeId = pickString(rels.route?.data?.id);
  const status = pickString(attrs.current_status).toUpperCase();
  const bearing = Number(attrs.bearing);
  const speed = Number(attrs.speed);
  return {
    id: pickString(resource.id).slice(0, 64),
    lat: roundNum(ll.lat),
    lon: roundNum(ll.lon),
    bearing: isFiniteNum(bearing) ? Math.round(bearing) : null,
    label: pickString(attrs.label).slice(0, 64),
    status: STATUS_LABELS[status] ?? pickString(status),
    stopSequence: Number.isFinite(Number(attrs.current_stop_sequence))
      ? Math.round(Number(attrs.current_stop_sequence)) : null,
    directionId: Number.isFinite(Number(attrs.direction_id))
      ? Math.round(Number(attrs.direction_id)) : null,
    occupancy: pickString(attrs.occupancy_status),
    speedMps: isFiniteNum(speed) ? roundNum(speed, 2) : null,
    routeId,
    routeName: routeId ? (routeNames.get(routeId) ?? routeId) : '',
    tripId: pickString(rels.trip?.data?.id).slice(0, 64),
    stopId: pickString(rels.stop?.data?.id).slice(0, 64),
    updatedAt: parseIso(attrs.updated_at),
  };
}

/** Parse a JSON:API envelope → normalized vehicle list. Pure, exported for tests. */
function parseVehicles(upstream) {
  const data = Array.isArray(upstream?.data) ? upstream.data : [];
  const routeNames = routeNameIndex(upstream?.included);
  const out = [];
  for (const resource of data) {
    const v = normalizeVehicle(resource, routeNames);
    if (v) out.push(v);
    if (out.length >= MAX_VEHICLES) break;
  }
  out.sort((a, b) => (a.routeName || '').localeCompare(b.routeName || '')
    || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return out;
}

function buildUpstreamUrl(routeId) {
  const params = new URLSearchParams();
  params.set('include', 'route');
  params.set('page[limit]', String(MAX_VEHICLES));
  if (routeId) params.set('filter[route]', routeId);
  return `${UPSTREAM_BASE}?${params.toString()}`;
}

async function fetchJsonCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). api-v3.mbta.com was
      // unreachable from the build VM, so no redirect claim is made here.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.api+json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`mbta_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('mbta_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error?.status === 502) throw error;
    if (error instanceof SyntaxError)
      throw Object.assign(new Error('mbta_upstream_bad_json'), { status: 502 });
    throw Object.assign(
      new Error(`mbta_fetch_failed: ${error?.message ?? 'unknown'}`),
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

function validateRouteParam(query) {
  const route = query.get('route');
  if (route == null || route === '') return null;
  if (!ROUTE_ID_RE.test(route))
    throw Object.assign(new Error('mbta_bad_route_param'), { status: 400 });
  return route;
}

async function getSnapshot(routeId) {
  const now = Date.now();
  const key = routeId ?? '*';
  if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = fetchJsonCapped(buildUpstreamUrl(routeId))
      .then((upstream) => {
        const vehicles = parseVehicles(upstream);
        const payload = {
          generatedAt: new Date().toISOString(),
          model: false,
          observation: true,
          source: 'MBTA v3 JSON API (normalized from GTFS-RT vehicle positions)',
          protobufNote: 'Raw GTFS-RT protobuf feed is proxied untouched at /api/transit (feed id "mbta"); protobuf decode is out of scope at the edge (no WASM, no node: imports).',
          attribution: 'MBTA open data — MassDOT Developers License.',
          route: routeId,
          count: vehicles.length,
          vehicles,
        };
        cache = { at: Date.now(), key, payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=30') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-7 MBTA normalized vehicle-positions proxy. Mirrors the trains provider shape. */
export function mbtaProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    let routeId;
    try {
      routeId = validateRouteParam(new URL(req.url, 'http://localhost').searchParams);
    } catch (error) {
      return sendJson(res, error.status ?? 400, { error: error.message }, 'no-store');
    }
    try {
      sendJson(res, 200, await getSnapshot(routeId));
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'mbta_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'mbta',
    configureServer({ middlewares }) {
      middlewares.use('/api/mbta', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/mbta', handler);
    },
  };
}

export const _mbtaInternals = {
  parseVehicles,
  normalizeVehicle,
  routeNameIndex,
  validateRouteParam,
  buildUpstreamUrl,
  clearCaches: () => { cache = null; inflight = null; },
};
