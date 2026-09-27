/**
 * Wave 8 — NHC tropical-cyclone GIS download index (catalog Wave D item 69, #133).
 *
 * HONESTLY PARTIAL: https://www.nhc.noaa.gov/gis/ is an HTML index page, not a
 * REST API. This provider scrapes the index for .zip download links (per
 * advisory: forecast cone, forecast track, best track, GTWO shapefiles) and
 * returns them as link metadata — it never downloads or parses the zips
 * themselves (that is out of scope for an edge proxy: shapefiles need GIS
 * tooling). `partial: true` is always set, with the reason in the payload.
 *
 * Probe notes (2026-09-27, build VM): the index returned HTTP 200 (~48 KB)
 * with 16 .zip hrefs; the /gis/examples/ ones are static samples (al112017 —
 * Irma 2017) and are filtered out; the live ones are relative paths like
 * forecast/archive/al062026_5day_latest.zip (relative to
 * https://www.nhc.noaa.gov/gis/).
 *
 * Routes:
 *   GET /api/nhc-gis → { generatedAt, partial, partialReason, indexUrl,
 *                         productCount, products:[{stormId, basin, stormNumber,
 *                         year, kind, filename, url}], attribution }
 *
 * Keyless, NHC/NOAA public domain, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error'
 * throws at the edge (main 2ec4053), no node: imports, no WASM).
 */

import { readResponseTextCapped } from '../common/http.js';

const INDEX_URL = 'https://www.nhc.noaa.gov/gis/';
const INDEX_BASE = 'https://www.nhc.noaa.gov/gis/';
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 256 * 1024; // index is ~48 KB; 256 KB is generous headroom
const CACHE_TTL_MS = 30 * 60_000; // per-advisory cadence; 30 min is plenty
const STALE_MS = 6 * 3600_000;
const RETRY_COOLDOWN_MS = 60_000;
const USER_AGENT = 'Gods Eye View (NHC GIS index layer)';

// Sample files NHC keeps on the index page for demo purposes — not live data.
const EXAMPLE_PREFIXES = ['/gis/examples/', 'examples/'];

const KIND_LABELS = {
  '5day_latest': '5-day forecast cone',
  fcst_latest: 'forecast track',
  best_track: 'best track',
  track_latest: 'forecast track',
  wind_radii: 'wind radii',
};

let cache = null; // {at, payload}
let inflight = null;
let attemptedAt = -Infinity;

/**
 * Parse a storm identifier like "al062026" into basin/stormNumber/year.
 * Returns null when the segment is not a storm id (e.g. gtwo_shapefiles).
 */
export function parseStormId(segment) {
  const m = /^([a-z]{2})(\d{2})(\d{4})$/i.exec(segment ?? '');
  if (!m) return null;
  const basinCode = m[1].toLowerCase();
  const basins = { al: 'Atlantic', ep: 'East Pacific', cp: 'Central Pacific' };
  return {
    stormId: segment.toLowerCase(),
    basin: basins[basinCode] ?? basinCode.toUpperCase(),
    stormNumber: Number(m[2]),
    year: Number(m[3]),
  };
}

/**
 * Scrape .zip hrefs from the NHC GIS index HTML. Example/sample files are
 * dropped; relative hrefs are resolved against the index base. Pure +
 * deterministic for tests.
 */
export function parseNhcGisIndex(html) {
  const products = [];
  const seen = new Set();
  const hrefRe = /href\s*=\s*["']([^"']+\.zip(?:\?[^"']*)?)["']/gi;
  let match;
  while ((match = hrefRe.exec(html)) !== null) {
    const raw = match[1];
    if (
      EXAMPLE_PREFIXES.some(
        (p) => raw.startsWith(p) || raw.toLowerCase().includes('/examples/'),
      )
    ) {
      continue; // static demo files, not live advisory data
    }
    let url;
    try {
      url = new URL(raw, INDEX_BASE).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const filename = url.split('/').pop().split('?')[0];
    const stem = filename.replace(/\.zip$/i, '');
    const parts = stem.split('_');
    const storm = parseStormId(parts[0]);
    const kindKey = parts.slice(1).join('_').toLowerCase();
    products.push({
      stormId: storm?.stormId ?? null,
      basin: storm?.basin ?? null,
      stormNumber: storm?.stormNumber ?? null,
      year: storm?.year ?? null,
      kind: KIND_LABELS[kindKey] ?? kindKey.replace(/_/g, ' ') ?? filename,
      filename,
      url,
    });
  }
  products.sort((a, b) => String(a.url).localeCompare(String(b.url)));
  return products;
}

async function fetchIndex(fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(INDEX_URL, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
    if (!res.ok)
      throw Object.assign(new Error(`nhc_gis_http_${res.status}`), {
        status: 502,
      });
    const text = await readResponseTextCapped(res, BODY_CAP_BYTES); // throws when too large
    const products = parseNhcGisIndex(text);
    if (!products.length) {
      throw Object.assign(
        new Error('nhc_gis_no_products: index held no .zip links'),
        {
          status: 502,
        },
      );
    }
    return { products };
  } finally {
    clearTimeout(timer);
  }
}

const PARTIAL_REASON =
  'Index scrape only: the NHC GIS page is an HTML index of binary .zip ' +
  'downloads (shapefiles), not a REST API. This endpoint lists the download ' +
  'URLs and classifies them — it does not download or parse the zips.';

function buildPayload(data, nowMs, stale) {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    partial: true,
    partialReason: PARTIAL_REASON,
    stale,
    indexUrl: INDEX_URL,
    productCount: data.products.length,
    products: data.products,
    attribution:
      'Tropical cyclone GIS index: NOAA National Hurricane Center (public domain).',
  };
}

async function getPayload(fetchImpl, nowMs, signal) {
  // nowMs is the injected clock (tests control it); real Date.now() is never
  // used for cache age so staleness is deterministic under test.
  if (cache && nowMs - cache.at < CACHE_TTL_MS)
    return buildPayload(cache.payload, nowMs, false);
  signal?.throwIfAborted?.();
  if (!inflight) {
    if (nowMs - attemptedAt < RETRY_COOLDOWN_MS)
      throw new Error('nhc_gis_retry_later');
    attemptedAt = nowMs;
    inflight = fetchIndex(fetchImpl)
      .then((data) => {
        cache = { at: nowMs, payload: data };
        return buildPayload(data, nowMs, false);
      })
      .finally(() => {
        inflight = null;
      });
  }
  if (!signal) return inflight;
  const cancelled = new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    const detach = () => signal.removeEventListener('abort', abort);
    inflight.then(detach, detach);
  });
  return Promise.race([inflight, cancelled]);
}

function sendJson(res, status, body, cacheControl = 'public, max-age=1800') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

export function nhcGisProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    try {
      try {
        sendJson(
          res,
          200,
          await getPayload(fetchImpl, now(), controller.signal),
        );
      } catch (error) {
        const usable = cache && now() - cache.at <= STALE_MS;
        if (usable) {
          sendJson(res, 200, buildPayload(cache.payload, now(), true));
          return;
        }
        const upstreamFail =
          error?.status === 502 ||
          error?.name === 'AbortError' ||
          /aborted?/i.test(error?.message ?? '');
        sendJson(
          res,
          upstreamFail ? 502 : 500,
          { error: 'nhc_gis_unavailable', detail: error?.message ?? 'unknown' },
          'no-store',
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'nhcGis',
    configureServer({ middlewares }) {
      middlewares.use('/api/nhc-gis', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/nhc-gis', handler);
    },
  };
}

export const _nhcGisInternals = {
  INDEX_URL,
  parseStormId,
  parseNhcGisIndex,
  PARTIAL_REASON,
  clearCaches: () => {
    cache = null;
    inflight = null;
    attemptedAt = -Infinity;
  },
};
