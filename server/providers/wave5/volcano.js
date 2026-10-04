/**
 * Volcano alert ticker proxy (keyless, two upstreams).
 *
 * Two honest, attribution-keeping sources:
 *   - GeoNet (GNS Science, NZ): https://api.geonet.org.nz/volcano/val — NRT
 *     GeoJSON volcanic alert levels for NZ volcanoes (all levels, incl. Green).
 *   - AVO (USGS/UAF Alaska): https://avo.alaska.edu/ — the front-page card
 *     set is scraped for volcanoes at ELEVATED alert status only (Alert
 *     Level + Color Code h3 cards + data-point coordinates). Normal-status
 *     Alaska volcanoes are NOT listed on the front page; the payload says so.
 *
 * Routes:
 *   GET /api/volcano → {generatedAt, geonet:{...}, avo:{...}, active:[...],
 *                       warnings:[...], sources:{geonet, avo}}
 *
 * Per-source fetch failures degrade to status:'error' in sources{} rather
 * than failing the whole endpoint — the ticker shows what is available and
 * names what is missing. Never fabricated.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const GEONET_URL = 'https://api.geonet.org.nz/volcano/val';
const AVO_URL = 'https://avo.alaska.edu/';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const GEONET_TTL_MS = 10 * 60_000;
const AVO_TTL_MS = 30 * 60_000;
const COORD_DECIMALS = 4;
const USER_AGENT = 'Gods Eye View (public volcano-alert context)';

const caches = new Map(); // key -> {at, payload}
const inflight = new Map();

async function fetchCapped(url, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/geo+json, text/html',
      },
    });
    if (!response.ok)
      throw Object.assign(new Error(`volcano_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('volcano_upstream_too_large'), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function cached(key, ttl, loader) {
  const now = Date.now();
  const hit = caches.get(key);
  if (hit && now - hit.at < ttl) return Promise.resolve(hit.payload);
  const running = inflight.get(key);
  if (running) return running;
  const p = loader()
    .then((payload) => {
      caches.set(key, { at: Date.now(), payload });
      return payload;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

function roundNum(value) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** COORD_DECIMALS;
  return Math.round(value * factor) / factor;
}

function str(value) {
  return String(value ?? '');
}

export function trimGeonetVolcano(feature) {
  const props = feature?.properties ?? {};
  const coords =
    feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : [];
  return {
    id: str(props.volcanoID),
    name: str(props.volcanoTitle),
    lon: roundNum(Number(coords[0])),
    lat: roundNum(Number(coords[1])),
    level: Number.isFinite(props.level) ? props.level : null,
    color: str(props.acc),
    activity: str(props.activity),
    hazards: str(props.hazards),
  };
}

/**
 * Parse AVO front-page elevated-alert cards.
 *
 * Card anatomy (front face): <h3>Alert Level: X</h3>, <h3>Color Code: Y</h3>,
 * a label with data-point="lat,lon", then the back face with
 * /volcano/<slug>/activity and the volcano name <h3>. Only volcanoes at
 * elevated status have these cards — capture is exactly that set.
 */
export function parseAvoCards(html) {
  const text = str(html);
  const pattern =
    /Alert Level:\s*([A-Za-z]+)\s*<\/h3>[\s\S]*?Color Code:\s*([A-Za-z]+)\s*<\/h3>[\s\S]*?data-point="([\d.\-]+),([\d.\-]+)"[\s\S]*?\/volcano\/([\w\-]+)\/activity[\s\S]*?<h3>([^<]+)<\/h3>/g;
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(pattern)) {
    const slug = m[5];
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      id: slug,
      name: m[6].trim(),
      lat: roundNum(Number(m[3])),
      lon: roundNum(Number(m[4])),
      alertLevel: m[1].toUpperCase(),
      colorCode: m[2].toUpperCase(),
      region: 'Alaska',
      url: `https://avo.alaska.edu/volcano/${slug}/activity`,
    });
  }
  return out;
}

function geonetActiveColor(v) {
  return (v.color || '').toUpperCase();
}

function buildActive(geonetVolcanoes, avoVolcanoes) {
  const active = [];
  for (const v of geonetVolcanoes) {
    if (!v.id) continue;
    const elevated =
      (v.level ?? 0) > 0 || !['GREEN', ''].includes(geonetActiveColor(v));
    if (!elevated) continue;
    active.push({
      id: `geonet:${v.id}`,
      name: v.name,
      lon: v.lon,
      lat: v.lat,
      level: v.level,
      levelText: v.activity,
      color: v.color,
      region: 'New Zealand',
      source: 'geonet',
    });
  }
  for (const v of avoVolcanoes) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
    active.push({
      id: `avo:${v.id}`,
      name: v.name,
      lon: v.lon,
      lat: v.lat,
      level: null,
      levelText: `Alert Level ${v.alertLevel}, Aviation Color Code ${v.colorCode}`,
      color: v.colorCode,
      region: 'Alaska',
      source: 'avo',
    });
  }
  return active;
}

async function getGeonet() {
  return cached('geonet', GEONET_TTL_MS, async () => {
    try {
      const text = await fetchCapped(GEONET_URL, null);
      const upstream = JSON.parse(text);
      const features = Array.isArray(upstream?.features)
        ? upstream.features
        : [];
      const volcanoes = features
        .map(trimGeonetVolcano)
        .filter(
          (v) => v.id && Number.isFinite(v.lon) && Number.isFinite(v.lat),
        );
      return { status: 'ok', count: volcanoes.length, volcanoes };
    } catch (error) {
      return {
        status: 'error',
        error: error?.message ?? 'unknown',
        count: 0,
        volcanoes: [],
      };
    }
  });
}

async function getAvo() {
  return cached('avo', AVO_TTL_MS, async () => {
    try {
      const html = await fetchCapped(AVO_URL, null);
      const volcanoes = parseAvoCards(html);
      return {
        status: 'ok',
        count: volcanoes.length,
        volcanoes,
        coverageNote:
          'AVO front page lists elevated-alert volcanoes only; normal-status Alaska volcanoes are not captured.',
      };
    } catch (error) {
      return {
        status: 'error',
        error: error?.message ?? 'unknown',
        count: 0,
        volcanoes: [],
        coverageNote: '',
      };
    }
  });
}

export async function trimVolcanoPayload(geonet, avo) {
  const active = buildActive(geonet.volcanoes, avo.volcanoes);
  const warnings = [];
  if (geonet.status === 'error')
    warnings.push(`geonet_unavailable: ${geonet.error}`);
  if (avo.status === 'error') warnings.push(`avo_unavailable: ${avo.error}`);
  return {
    generatedAt: new Date().toISOString(),
    geonet,
    avo,
    activeCount: active.length,
    active,
    warnings,
    sources: { geonet: geonet.status, avo: avo.status },
    source:
      'GeoNet VAL (GNS Science, NZ) + AVO front page (USGS/UAF, Alaska) — keyless',
  };
}

async function getSnapshot() {
  const [geonet, avo] = await Promise.all([getGeonet(), getAvo()]);
  return trimVolcanoPayload(geonet, avo);
}

function sendJson(res, status, body, cacheControl = 'public, max-age=600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the volcano alert-ticker proxy. Mirrors the nwsAlerts provider shape. */
export function volcanoProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    req.on?.('close', () => {});
    try {
      // Per-source degradation lives inside the payload; only an unexpected
      // internal failure reaches 500 — data itself is never fabricated.
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      sendJson(
        res,
        500,
        {
          error: 'volcano_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    } finally {
      req.removeListener?.('close', () => {});
    }
  }

  return {
    name: 'volcano',
    configureServer({ middlewares }) {
      middlewares.use('/api/volcano', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/volcano', handler);
    },
  };
}

export const _volcanoInternals = {
  trimGeonetVolcano,
  parseAvoCards,
  buildActive,
  trimVolcanoPayload,
  clearCaches: () => {
    caches.clear();
    inflight.clear();
  },
};
