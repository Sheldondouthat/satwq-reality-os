/**
 * NWS CAP alert polygons proxy (keyless).
 *
 * api.weather.gov requires no API key and serves GeoJSON, but it serves no
 * CORS headers, so browsers cannot fetch it directly. This provider trims
 * the ~2 MB upstream payload to the fields the globe needs and caches it.
 *
 * Routes:
 *   GET /api/nws-alerts → {generatedAt, count, withGeometry, alerts:[...]}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd does NOT implement redirect:'error'
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const UPSTREAM_URL = 'https://api.weather.gov/alerts/active?status=actual';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const DESCRIPTION_CAP = 2_000;
const COORD_DECIMALS = 5;
const USER_AGENT = 'Gods Eye View (public NWS alert context)';

let cache = null; // {at, payload}
let inflight = null;

async function fetchJsonCapped(url, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`nws_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('nws_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function roundNum(value) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** COORD_DECIMALS;
  return Math.round(value * factor) / factor;
}

function trimGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  const type = geometry.type;
  if (type !== 'Polygon' && type !== 'MultiPolygon') return null;
  const ringify = (rings) =>
    rings.map((ring) => ring.map((pos) => pos.map(roundNum)));
  const coordinates =
    type === 'Polygon'
      ? ringify(geometry.coordinates)
      : geometry.coordinates.map(ringify);
  return { type, coordinates };
}

function trimAlert(feature) {
  const props = feature?.properties ?? {};
  const description = String(props.description ?? '');
  return {
    id: String(feature?.id ?? props.id ?? ''),
    event: String(props.event ?? ''),
    headline: String(props.headline ?? ''),
    description:
      description.length > DESCRIPTION_CAP
        ? description.slice(0, DESCRIPTION_CAP) + '…'
        : description,
    severity: String(props.severity ?? ''),
    certainty: String(props.certainty ?? ''),
    urgency: String(props.urgency ?? ''),
    effective: props.effective ?? null,
    expires: props.expires ?? null,
    onset: props.onset ?? null,
    senderName: String(props.senderName ?? ''),
    areaDesc: String(props.areaDesc ?? ''),
    affectedZones: Array.isArray(props.affectedZones)
      ? props.affectedZones.filter((z) => typeof z === 'string').slice(0, 32)
      : [],
    geometry: trimGeometry(feature?.geometry),
  };
}

export function trimNwsAlertsPayload(upstream) {
  const features = Array.isArray(upstream?.features) ? upstream.features : [];
  const alerts = features.map(trimAlert).filter((a) => a.id && a.event);
  return {
    generatedAt: new Date().toISOString(),
    count: alerts.length,
    withGeometry: alerts.filter((a) => a.geometry).length,
    alerts,
    source: 'api.weather.gov — National Weather Service (keyless GeoJSON)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = fetchJsonCapped(UPSTREAM_URL, null)
      .then((upstream) => {
        const payload = trimNwsAlertsPayload(upstream);
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=300') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the NWS alerts proxy. Mirrors the vaac/hmsSmoke provider shape. */
export function nwsAlertsProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    req.on?.('close', () => {});
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      sendJson(
        res,
        error?.status === 502 ? 502 : 500,
        {
          error: 'nws_alerts_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    } finally {
      req.removeListener?.('close', () => {});
    }
  }

  return {
    name: 'nws-alerts',
    configureServer({ middlewares }) {
      middlewares.use('/api/nws-alerts', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/nws-alerts', handler);
    },
  };
}

export const _nwsAlertsInternals = {
  trimGeometry,
  trimAlert,
  trimNwsAlertsPayload,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
