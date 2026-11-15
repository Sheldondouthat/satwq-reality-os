/**
 * Wave 3 — USGS New River at Glen Lyn, VA (03176500) proxy (keyless).
 *
 * The V5-0 floor feed: the single named home gauge, served on the WDFN
 * API V1 path from the canonical registry record
 * (sky-map-quest/registry/glen-lyn-03176500.v2.feedspec.json,
 * registry_version 0.2.0). The older basin bundle
 * (/api/usgs-water-newriver-valley) cannot serve this role: it carries
 * discharge only (parameterCd=00060 — no gage height, so the 13 ft /
 * 15 ft stage thresholds cannot be computed) and its upstream is
 * WaterServices, which USGS decommissions in early 2027. This provider
 * fetches the registry record's own endpoint — WDFN latest-continuous
 * for station 03176500, parameters 00060 + 00065 — and trims it to the
 * floor record shape. Faces consume this GEV API, never USGS directly.
 *
 * Routes:
 *   GET /api/usgs-water-glen-lyn → {generatedAt, stale, dataTime,
 *     ageSeconds, maxAgeSeconds, gageHeightFt, dischargeCfs,
 *     approvalStatus, variables:{...}, thresholds:{...}, ...}
 *
 * Payload shape pinned against a live fetch on 2026-11-15: WDFN
 * latest-continuous returns a GeoJSON FeatureCollection; each feature
 * carries properties {parameter_code, time (ISO-8601 UTC), value
 * (string), unit_of_measure, approval_status, last_modified} and a
 * Point geometry. Absence of a feature for a parameter is the no-data
 * signal (the WaterML -999999 sentinel does not survive, registry §3.2).
 *
 * Honesty rules (Liveness Law + the 2026-11-15 D-1 fix): the reading's
 * age is computed from the DATA's own timestamp (dataTime = the older
 * of the two variables' times — a reading is only as fresh as its
 * stalest load-bearing value), never from generatedAt; past the
 * registry max-age (3,600 s) the payload is labeled stale:true. On
 * upstream failure the last good payload is served with stale:true +
 * degraded:true + a named error — never a silent empty, never a 502
 * dressed as data (the D-6 pattern). A 502 is returned only when no
 * reading has ever been fetched.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * no node: imports, no WASM). USGS data are U.S. public domain.
 */

const UPSTREAM_URL =
  'https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-continuous/items?monitoring_location_number=03176500&parameter_code=00060,00065';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 300_000; // registry poll is 900 s; 5-min edge cache is polite and fresher
const MAX_AGE_SECONDS = 3600; // registry record v2 freshness.max_age_seconds
const SITE = '03176500';
const SITE_NAME = 'NEW RIVER AT GLEN LYN, VA';
const CAUTION_FT = 13.0; // local rule (river_bot), labeled as such wherever used
const FLOOD_STAGE_FT = 15.0; // NWS flood stage for this gauge
const USER_AGENT = 'Gods Eye View (USGS Glen Lyn gauge context)';

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
        Accept: 'application/geo+json, application/json',
      },
    });
    if (!response.ok)
      throw Object.assign(new Error(`glenlyn_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('glenlyn_upstream_too_large'), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

function num(value, decimals) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function toIsoUtc(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseVariable(feature, name, unit, decimals) {
  if (!feature || typeof feature !== 'object') return null;
  const p = feature.properties || {};
  const value = num(p.value, decimals);
  const time = toIsoUtc(p.time);
  if (value == null || time == null) return null;
  return {
    name,
    value,
    unit: typeof p.unit_of_measure === 'string' ? p.unit_of_measure : unit,
    time,
    approvalStatus:
      typeof p.approval_status === 'string' ? p.approval_status : null,
    lastModified: toIsoUtc(p.last_modified),
  };
}

/**
 * Pure parser for tests: WDFN latest-continuous GeoJSON (object or text)
 * → { gageHeight, discharge, lat, lon } with per-variable records.
 * Throws when the payload carries neither variable (no-data = absence).
 */
export function parseGlenLynPayload(input) {
  const doc = typeof input === 'string' ? JSON.parse(input) : input;
  const features = Array.isArray(doc?.features) ? doc.features : [];
  let heightFeature = null;
  let flowFeature = null;
  let lat = null;
  let lon = null;
  for (const feature of features) {
    const code = feature?.properties?.parameter_code;
    if (code === '00065' && !heightFeature) heightFeature = feature;
    if (code === '00060' && !flowFeature) flowFeature = feature;
    const coords = feature?.geometry?.coordinates;
    if (
      lat == null &&
      Array.isArray(coords) &&
      Number.isFinite(coords[0]) &&
      Number.isFinite(coords[1])
    ) {
      lon = coords[0];
      lat = coords[1];
    }
  }
  const gageHeight = parseVariable(heightFeature, 'Gage height', 'ft', 2);
  const discharge = parseVariable(
    flowFeature,
    'Streamflow',
    'ft^3/s',
    0,
  );
  if (!gageHeight && !discharge)
    throw Object.assign(new Error('glenlyn_no_data'), { status: 502 });
  return { gageHeight, discharge, lat, lon };
}

/**
 * Build the served envelope from a parsed reading. Age and staleness
 * are computed from dataTime (the older variable time) at build time.
 */
export function buildGlenLynPayload(parsed, nowMs = Date.now()) {
  const variables = {};
  if (parsed.gageHeight) variables['00065'] = parsed.gageHeight;
  if (parsed.discharge) variables['00060'] = parsed.discharge;
  const times = [parsed.gageHeight?.time, parsed.discharge?.time]
    .filter(Boolean)
    .map((t) => Date.parse(t));
  const dataTimeMs = Math.min(...times);
  const dataTime = new Date(dataTimeMs).toISOString();
  const ageSeconds = Math.max(0, Math.floor((nowMs - dataTimeMs) / 1000));
  return {
    id: 'usgs-water-glen-lyn',
    title: 'USGS Water — New River at Glen Lyn, VA (03176500)',
    source: 'USGS WDFN API V1 — latest-continuous (NWIS)',
    attribution: 'Data: U.S. Geological Survey, NWIS — keyless.',
    generatedAt: new Date(nowMs).toISOString(),
    stale: ageSeconds > MAX_AGE_SECONDS,
    site: SITE,
    name: SITE_NAME,
    lat: parsed.lat,
    lon: parsed.lon,
    dataTime,
    ageSeconds,
    maxAgeSeconds: MAX_AGE_SECONDS,
    gageHeightFt: parsed.gageHeight ? parsed.gageHeight.value : null,
    dischargeCfs: parsed.discharge ? parsed.discharge.value : null,
    approvalStatus:
      parsed.gageHeight?.approvalStatus ??
      parsed.discharge?.approvalStatus ??
      null,
    variables,
    thresholds: { cautionFt: CAUTION_FT, floodStageFt: FLOOD_STAGE_FT },
    note: 'Single-gauge floor feed for USGS 03176500 on the WDFN path (registry record glen-lyn-03176500 v0.2.0). dataTime is the reading\u2019s own timestamp — the older of the two variables; ageSeconds and stale are computed from it, never from generatedAt. Thresholds: caution 13 ft is a local rule; flood stage 15 ft is the NWS flood stage for this gauge. Provisional data are subject to revision.',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    // Rebuild the envelope so ageSeconds/stale are true at serve time,
    // not frozen at fetch time.
    return buildGlenLynPayload(cache.parsed, now);
  }
  if (!inflight) {
    inflight = fetchTextCapped(UPSTREAM_URL)
      .then((text) => {
        const parsed = parseGlenLynPayload(text);
        cache = { at: Date.now(), parsed };
        return parsed;
      })
      .finally(() => {
        inflight = null;
      });
  }
  const parsed = await inflight;
  return buildGlenLynPayload(parsed, Date.now());
}

function sendJson(res, status, body, cacheControl = 'public, max-age=300') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the Glen Lyn gauge proxy. Mirrors the wave6 provider shape. */
export function glenLynProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      // Honest degradation (D-6 pattern): serve the last good reading
      // labeled stale + degraded; 502 only when nothing was ever held.
      if (cache) {
        const payload = buildGlenLynPayload(cache.parsed, Date.now());
        return sendJson(
          res,
          200,
          {
            ...payload,
            stale: true,
            degraded: true,
            error: 'glenlyn_upstream_unavailable',
            degradedReason: `WDFN fetch failed (${error?.message ?? 'unknown'}); serving the last good reading with its age.`,
          },
          'no-store',
        );
      }
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'glenlyn_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'glen-lyn',
    configureServer({ middlewares }) {
      middlewares.use('/api/usgs-water-glen-lyn', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/usgs-water-glen-lyn', handler);
    },
  };
}

export const _glenLynInternals = {
  parseGlenLynPayload,
  buildGlenLynPayload,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
