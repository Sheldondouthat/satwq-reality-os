/**
 * GDACS multi-hazard proxy (keyless).
 *
 * GDACS (EU JRC) publishes a live multi-hazard event list GeoJSON covering
 * tropical cyclones, floods, wildfires, earthquakes, volcanoes and droughts.
 * No CORS headers, so the browser cannot fetch it directly — this provider
 * trims the ~130 KB payload to what the globe needs and caches it.
 *
 * Routes:
 *   GET /api/hazards → {generatedAt, count, currentCount, byType, events:[...]}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const UPSTREAM_URL = 'https://gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60_000;
const COORD_DECIMALS = 4;
const USER_AGENT = 'Gods Eye View (public multi-hazard context)';

/** Event types GDACS publishes; kept as an allowlist so junk never renders. */
export const HAZARD_TYPES = ['EQ', 'FL', 'TC', 'WF', 'VO', 'DR'];

const ALERT_RANK = { Red: 0, Orange: 1, Green: 2 };

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
      throw Object.assign(new Error(`gdacs_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('gdacs_upstream_too_large'), { status: 502 });
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

function str(value) {
  return String(value ?? '');
}

export function trimHazardEvent(feature) {
  const props = feature?.properties ?? {};
  const coords = feature?.geometry?.type === 'Point'
    ? feature.geometry.coordinates
    : [];
  const severity = props.severitydata ?? {};
  const urls = props.url ?? {};
  return {
    eventtype: HAZARD_TYPES.includes(props.eventtype) ? props.eventtype : 'OTHER',
    eventid: Number.isFinite(props.eventid) ? props.eventid : null,
    episodeid: Number.isFinite(props.episodeid) ? props.episodeid : null,
    name: str(props.name || props.description),
    lon: roundNum(Number(coords[0])),
    lat: roundNum(Number(coords[1])),
    alertlevel: ['Red', 'Orange', 'Green'].includes(props.alertlevel)
      ? props.alertlevel
      : 'Orange',
    alertscore: Number.isFinite(props.alertscore) ? props.alertscore : null,
    country: str(props.country),
    iso3: str(props.iso3),
    fromdate: str(props.fromdate),
    todate: str(props.todate),
    datemodified: str(props.datemodified),
    severityText: str(severity.severitytext),
    iscurrent: str(props.iscurrent).toLowerCase() === 'true',
    reportUrl: str(urls.report),
    detailUrl: str(urls.details),
    source: str(props.source),
  };
}

export function trimHazardsPayload(upstream) {
  const features = Array.isArray(upstream?.features) ? upstream.features : [];
  const events = features
    .map(trimHazardEvent)
    .filter((e) => e.eventid !== null && Number.isFinite(e.lon) && Number.isFinite(e.lat))
    .sort((a, b) =>
      (ALERT_RANK[a.alertlevel] ?? 1) - (ALERT_RANK[b.alertlevel] ?? 1) ||
      (b.alertscore ?? 0) - (a.alertscore ?? 0),
    );
  const byType = {};
  for (const e of events) byType[e.eventtype] = (byType[e.eventtype] ?? 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    count: events.length,
    currentCount: events.filter((e) => e.iscurrent).length,
    byType,
    events,
    source: 'GDACS (EU Joint Research Centre, keyless multi-hazard feed)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = fetchJsonCapped(UPSTREAM_URL, null)
      .then((upstream) => {
        const payload = trimHazardsPayload(upstream);
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=900') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the GDACS multi-hazard proxy. Mirrors the nwsAlerts provider shape. */
export function hazardsProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    req.on?.('close', () => {});
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      sendJson(res, error?.status === 502 ? 502 : 500, {
        error: 'hazards_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    } finally {
      req.removeListener?.('close', () => {});
    }
  }

  return {
    name: 'hazards',
    configureServer({ middlewares }) {
      middlewares.use('/api/hazards', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/hazards', handler);
    },
  };
}

export const _hazardsInternals = {
  trimHazardEvent,
  trimHazardsPayload,
  HAZARD_TYPES,
  clearCaches: () => { cache = null; inflight = null; },
};
