/**
 * Wave 3 Track 2c / 2.13 — GDELT planetary attention heat bubbles.
 *
 * Proxies the GDELT GKG GeoJSON v1 endpoint
 * (https://api.gdeltproject.org/api/v1/gkg_geojson). NOTE: the v1 endpoint
 * only honors LOWERCASE query params (`query`, `timespan`) — uppercase
 * QUERY/TIMESPAN returns an empty FeatureCollection (verified 2026-09-27).
 * GDELT v2 is dead (404); v1 only.
 *
 * The client passes ?q=<gdelt query>&timespan=<minutes>; the provider caches
 * per normalized query (bounded). Default query is a broad attention sweep.
 * Keyless, plain fetch + JSON.
 */
import { createKeylessProxy, fetchUpstreamText } from './lib/proxy.js';

const BASE = 'https://api.gdeltproject.org/api/v1/gkg_geojson';
const USER_AGENT = 'SATWQ-RealityOS/1.0 (GDELT public API; keyless; contact via repo)';
const DEFAULT_QUERY = '(earthquake OR protest OR election OR flood OR wildfire OR summit)';
const DEFAULT_TIMESPAN = 60;
const MAX_TIMESPAN = 1440;
const MAX_FEATURES = 800;

const CACHE_TTL_MS = 15 * 60_000;
const STALE_MS = 2 * 60 * 60_000;
const UPSTREAM_TIMEOUT_MS = 25_000;
const TEXT_CAP = 8 * 1024 * 1024;

/** Normalize one GeoJSON feature to the attention-bubble shape. Exported for tests. */
export function normalizeGdeltFeature(feature) {
  const coords = feature?.geometry?.coordinates;
  const lon = Number(coords?.[0]);
  const lat = Number(coords?.[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  const p = feature?.properties ?? {};
  // Defense: URLs are rendered as <a href> in the globe UI — accept only
  // http(s) so a crafted scheme or quote-breakout can never reach the DOM.
  const rawUrl = p.url ? String(p.url).slice(0, 300) : null;
  const url = rawUrl && /^(https?:\/\/)/i.test(rawUrl) ? rawUrl : null;
  return {
    lon: Math.round(lon * 1000) / 1000,
    lat: Math.round(lat * 1000) / 1000,
    name: p.name ? String(p.name).slice(0, 120) : null,
    tone: Number.isFinite(+p.urltone) ? +p.urltone : null,
    url,
    themes: p.mentionedthemes ? String(p.mentionedthemes).slice(0, 400) : null,
    publishedAt: p.urlpubtimedate ?? null,
  };
}

export function parseGdeltGeojson(text) {
  const doc = JSON.parse(text);
  const features = Array.isArray(doc?.features) ? doc.features : [];
  const out = [];
  for (const f of features) {
    const n = normalizeGdeltFeature(f);
    if (n) out.push(n);
    if (out.length >= MAX_FEATURES) break;
  }
  return out;
}

export function gdeltProxy({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  async function fetchUpstream({ fetchImpl: f, signal, now: n, query }) {
    const q = (query.get('q') || DEFAULT_QUERY).slice(0, 300);
    const timespan = Math.min(
      MAX_TIMESPAN,
      Math.max(1, parseInt(query.get('timespan') || String(DEFAULT_TIMESPAN), 10) || DEFAULT_TIMESPAN),
    );
    const url =
      `${BASE}?query=${encodeURIComponent(q)}&timespan=${timespan}`;
    const text = await fetchUpstreamText(f, url, {
      signal,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      textCap: TEXT_CAP,
      userAgent: USER_AGENT,
      accept: 'application/json',
    });
    return { fetchedAt: n(), query: q, timespan, mentions: parseGdeltGeojson(text) };
  }

  function describe(payload, { stale = false, reason = null } = {}) {
    return {
      schemaVersion: 1,
      source: 'GDELT GKG GeoJSON v1 via local proxy',
      attribution:
        'News-mention geodata © GDELT Project. ' +
        'v1 endpoint requires lowercase query/timespan params (verified).',
      fetchedAt: payload?.fetchedAt ?? null,
      stale,
      unavailable: !payload,
      reason,
      query: payload?.query ?? null,
      timespan: payload?.timespan ?? null,
      count: payload?.mentions?.length ?? 0,
      mentions: payload?.mentions ?? [],
    };
  }

  return createKeylessProxy({
    name: 'gdelt',
    route: '/api/gdelt',
    ttlMs: CACHE_TTL_MS,
    staleMs: STALE_MS,
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    fetchUpstream,
    describe,
    cacheKey: (query) =>
      `${(query.get('q') || DEFAULT_QUERY).slice(0, 120)}|${query.get('timespan') || DEFAULT_TIMESPAN}`,
    fetchImpl,
    now,
  });
}
