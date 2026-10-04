/**
 * Wave 6 — Open Glider Network live-marker proxy (keyless, attribution).
 *
 * OGN's live.glidernet.org/lxml.php endpoint serves the current FLARM
 * glider/GA position markers as XML (keyless HTTP — no TCP socket needed).
 * This provider parses the marker stream with regexes (no DOMParser at the
 * edge), keeps the fields the globe needs, and caches for 5 minutes.
 *
 * Routes:
 *   GET /api/gliders → {generatedAt, count, markers:[...]}
 *
 * Marker shape: {id, lat, lon, altM, heading, speedKmh, reg, cn, type}
 * Unknown/optional attributes are carried as null rather than dropped.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const UPSTREAM_URL = 'https://live.glidernet.org/lxml.php';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_MARKERS = 5000;
const USER_AGENT = 'Gods Eye View (glider/GA position context)';

let cache = null; // {at, payload}
let inflight = null;

async function fetchTextCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/xml, text/xml',
      },
    });
    if (!response.ok)
      throw Object.assign(new Error(`gliders_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('gliders_upstream_too_large'), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

function parseMarkerAttrs(tag) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

function numOrNull(value, decimals) {
  // NOTE: Number(null) === 0, so nulls must be screened before coercion.
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (decimals == null) return n;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/**
 * OGN live XML wraps positions in <markers><m .../> elements. Attribute
 * names have drifted over the years, so latitude/longitude/identifier are
 * resolved from a small set of known aliases rather than a fixed schema.
 */
export function parseOgnMarkers(xml) {
  if (typeof xml !== 'string' || !xml) return [];
  const markers = [];
  const tagRe = /<m\b[^>]*\/?>/gi;
  let tag;
  while ((tag = tagRe.exec(xml)) !== null) {
    const a = parseMarkerAttrs(tag[0]);
    const lat = numOrNull(a.lat ?? a.latitude, 5);
    const lon = numOrNull(a.lng ?? a.lon ?? a.long ?? a.longitude, 5);
    if (lat == null || lon == null) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const id =
      String(a.id ?? a.flarm ?? a.device ?? a.callsign ?? '').slice(0, 32) ||
      null;
    markers.push({
      id,
      lat,
      lon,
      altM: numOrNull(a.a ?? a.alt ?? a.altitude, 0),
      heading: numOrNull(a.c ?? a.heading ?? a.course, 0),
      speedKmh: numOrNull(a.s ?? a.speed, 1),
      reg: String(a.reg ?? a.registration ?? '').slice(0, 16) || null,
      cn: String(a.cn ?? a.competition ?? '').slice(0, 8) || null,
      type: String(a.t ?? a.type ?? '').slice(0, 24) || null,
    });
    if (markers.length >= MAX_MARKERS) break;
  }
  return markers;
}

export function trimGlidersPayload(xml) {
  const markers = parseOgnMarkers(xml);
  return {
    generatedAt: new Date().toISOString(),
    count: markers.length,
    capped: markers.length >= MAX_MARKERS,
    markers,
    note: 'Open Glider Network live FLARM markers (gliders + GA), keyless HTTP XML.',
    source: 'Open Glider Network (attribution)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = fetchTextCapped(UPSTREAM_URL)
      .then((xml) => {
        const payload = trimGlidersPayload(xml);
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

/** Mount the OGN live-marker proxy. Mirrors the felt provider shape. */
export function glidersProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'gliders_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'gliders',
    configureServer({ middlewares }) {
      middlewares.use('/api/gliders', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/gliders', handler);
    },
  };
}

export const _glidersInternals = {
  parseOgnMarkers,
  trimGlidersPayload,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
