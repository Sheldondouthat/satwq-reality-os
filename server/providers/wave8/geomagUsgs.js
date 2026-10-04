/**
 * Wave D — USGS geomagnetic observatory provider (catalog item 73, #44).
 *
 * Upstream (verified live 2026-09-27):
 *   https://geomag.usgs.gov/ws/data/?id=BOU&starttime=…&endtime=…&format=iaga2002
 * returns IAGA-2002 fixed-width TEXT (1-minute adjusted XYZF values) — pure
 * text, custom edge-safe parser below. No node: imports, no WASM.
 *
 * ROUTE NOTE: /api/geomag is already owned by wave3/intermagnet.js (BGS HAPI,
 * scalar field magnitude, global observatories). This provider is a DIFFERENT
 * upstream and data product (USGS observatories, full vector X/Y/Z + total F
 * in nT), so it mounts /api/geomag-usgs instead. Coordinator: merge/alias as
 * the frontend needs.
 *
 * Sentinel honesty: IAGA-2002 uses 99999.00 for missing and 88888.00 for
 * spike-flagged values. We surface them as null and report the latest VALID
 * sample separately — the most recent ROW is often still missing data.
 *
 * Routes:
 *   GET /api/geomag-usgs → { generatedAt, stale, observatory:{…}, window:{…},
 *     latest:{…}, latestValid:{…}, stats:{…}, series:[…], attribution }
 * Query: ?id=BOU (allowlisted USGS IAGA codes, default BOU), ?hours=1..24 (default 3).
 *
 * Keyless, USGS public domain, Pages-safe (global fetch only, capped reads,
 * redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 */

import { readResponseTextCapped } from '../common/http.js';

const DATA_URL = 'https://geomag.usgs.gov/ws/data/';
// USGS IAGA codes verified live 2026-09-27 (each returned HTTP 200 with data
// or honest 99999 rows). Untested codes are excluded on purpose.
const OBSERVATORIES = {
  BOU: { name: 'Boulder', lat: 40.137, lon: -105.237 },
  BRW: { name: 'Barrow', lat: 71.322, lon: -156.622 },
  CMO: { name: 'College', lat: 64.874, lon: -147.86 },
  DED: { name: 'Deadhorse', lat: 70.355, lon: -148.793 },
  FRD: { name: 'Fredericksburg', lat: 38.205, lon: -77.373 },
  GUA: { name: 'Guam', lat: 13.588, lon: 144.867 },
  HON: { name: 'Honolulu', lat: 21.316, lon: -158.0 },
  NEW: { name: 'Newport', lat: 48.265, lon: -117.122 },
  SHU: { name: 'Shumagin', lat: 55.348, lon: -160.462 },
  SIT: { name: 'Sitka', lat: 57.058, lon: -135.325 },
  SJG: { name: 'San Juan', lat: 18.113, lon: -66.151 },
  TUC: { name: 'Tucson', lat: 32.174, lon: -110.733 },
};
const DEFAULT_ID = 'BOU';
const DEFAULT_HOURS = 3;
const MAX_HOURS = 24;
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 512 * 1024; // 24 h @ 1-min ≈ 100 KB; generous headroom
const CACHE_TTL_MS = 5 * 60_000;
const RETRY_COOLDOWN_MS = 60_000;
const STALE_MS = 6 * 3600_000;
const MIN_ROWS = 5;
const USER_AGENT = 'Gods Eye View (USGS geomagnetic layer)';

let cache = null; // {at, key, payload}
let inflight = null; // {key, promise}
let attemptedAt = -Infinity;

/**
 * Parse an IAGA-2002 document (fixed-width text). Throws {status:502} on bad
 * shape. Missing values (99999.00) and spike-flagged (88888.00) become null.
 */
export function parseIaga2002(text) {
  const fail = (msg) =>
    Object.assign(new Error(`geomag_iaga_invalid: ${msg}`), { status: 502 });
  const meta = {};
  let columns = null;
  const rows = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    // Column header row: "DATE  TIME  DOY  BOUX BOUY BOUZ BOUF |" — detect
    // first: real responses carry NO leading space on this line, so it must
    // not fall into the data-row branch (it would parse as a junk row).
    if (/^\s*DATE\s/i.test(line)) {
      columns = line.split('|')[0].split(/\s+/).filter(Boolean);
      continue;
    }
    if (line.startsWith(' ')) {
      const inner = line.slice(1).split('|')[0];
      const key = inner.slice(0, 23).trim();
      const value = inner.slice(23).trim();
      if (!key) continue;
      meta[key] = value;
      continue;
    }
    const s = line.trim();
    if (!s) continue;
    const parts = s.split(/\s+/);
    if (parts.length < 7) continue;
    rows.push(parts);
  }
  if (!columns || columns.length < 7)
    throw fail('missing data column header row');
  const compNames = columns.slice(3, 7); // e.g. ["BOUX","BOUY","BOUZ","BOUF"]
  const series = [];
  for (const parts of rows) {
    const t = Date.parse(`${parts[0]}T${parts[1]}Z`);
    if (!Number.isFinite(t)) continue;
    const comps = parts.slice(3, 7).map((v) => {
      const n = Number(v);
      // IAGA-2002 sentinels: 99999.00 missing, 88888.00 spike-flagged.
      if (!Number.isFinite(n) || Math.abs(n) >= 88888) return null;
      return n;
    });
    series.push({
      t: new Date(t).toISOString(),
      x: comps[0],
      y: comps[1],
      z: comps[2],
      f: comps[3],
    });
  }
  if (series.length < MIN_ROWS)
    throw fail(
      `only ${series.length} data rows (min ${MIN_ROWS}) — upstream returned an empty or broken file`,
    );
  return {
    meta: {
      format: meta['Format'] ?? null,
      source: meta['Source of Data'] ?? null,
      stationName: meta['Station Name'] ?? null,
      iagaCode: meta['IAGA CODE'] ?? null,
      lat: Number(meta['Geodetic Latitude']),
      lon: Number(meta['Geodetic Longitude']),
      elevation: Number(meta['Elevation']),
      reported: meta['Reported'] ?? null,
      sensorOrientation: meta['Sensor Orientation'] ?? null,
      digitalSampling: meta['Digital Sampling'] ?? null,
      dataIntervalType: meta['Data Interval Type'] ?? null,
      dataType: meta['Data Type'] ?? null,
    },
    compNames,
    series,
  };
}

/** Horizontal intensity H = sqrt(X^2+Y^2) and declination D in degrees. */
export function deriveHD(x, y) {
  if (x == null || y == null) return { h: null, d: null };
  const h = Math.hypot(x, y);
  const d = (Math.atan2(y, x) * 180) / Math.PI;
  return { h: Math.round(h * 100) / 100, d: Math.round(d * 100) / 100 };
}

function summarize(values) {
  if (!values.length)
    return { min: null, max: null, mean: null, validCount: 0 };
  let min = Infinity,
    max = -Infinity,
    sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const r = (n) => Math.round(n * 100) / 100;
  return {
    min: r(min),
    max: r(max),
    mean: r(sum / values.length),
    validCount: values.length,
  };
}

/** Build the publishable payload from a parsed IAGA-2002 document. Pure. */
export function buildGeomagPayload(parsed, { id, hours, nowMs }) {
  const { series } = parsed;
  const latest = series[series.length - 1];
  let latestValid = null;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].x != null && series[i].y != null && series[i].z != null) {
      latestValid = series[i];
      break;
    }
  }
  const col = (k) => series.map((r) => r[k]).filter((v) => v != null);
  const stats = {
    x: summarize(col('x')),
    y: summarize(col('y')),
    z: summarize(col('z')),
    f: summarize(col('f')),
  };
  const latestHD = deriveHD(latestValid?.x ?? null, latestValid?.y ?? null);
  const curated = OBSERVATORIES[id];
  return {
    generatedAt: new Date(nowMs).toISOString(),
    stale: false,
    observatory: {
      id,
      name: parsed.meta.stationName || curated.name,
      lat: Number.isFinite(parsed.meta.lat) ? parsed.meta.lat : curated.lat,
      lon: Number.isFinite(parsed.meta.lon) ? parsed.meta.lon : curated.lon,
      elevationM: parsed.meta.elevation,
      reported: parsed.meta.reported,
      dataType: parsed.meta.dataType,
      dataIntervalType: parsed.meta.dataIntervalType,
      components: parsed.compNames,
    },
    window: {
      hours,
      rows: series.length,
      first: series[0].t,
      last: latest.t,
    },
    latest: {
      ...latest,
      valid: latestValid != null && latest.t === latestValid.t,
    },
    latestValid: latestValid ? { ...latestValid, ...latestHD } : null,
    stats,
    derivedNote:
      'h = horizontal intensity sqrt(X^2+Y^2), d = declination atan2(Y,X) in degrees; ' +
      'computed at the edge from USGS 1-minute adjusted vector components, in nT.',
    series,
    attribution:
      'Geomagnetic observatory data: U.S. Geological Survey (public domain), ' +
      `IAGA-2002 1-minute adjusted values via geomag.usgs.gov/ws. Missing values ` +
      '(99999.00) and spike-flagged values (88888.00) are surfaced as null.',
  };
}

export function buildDataUrl({ id, hours, endMs }) {
  const end = new Date(endMs);
  const start = new Date(endMs - hours * 3600_000);
  const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const params = new URLSearchParams({
    id,
    starttime: fmt(start),
    endtime: fmt(end),
    format: 'iaga2002',
  });
  return `${DATA_URL}?${params.toString()}`;
}

function parseQuery(url) {
  const params = new URL(url, 'http://localhost').searchParams;
  const id = (params.get('id') ?? DEFAULT_ID).toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(OBSERVATORIES, id))
    throw Object.assign(new Error(`geomag_bad_id: ${id}`), { status: 400 });
  const hours = Number(params.get('hours') ?? DEFAULT_HOURS);
  if (!Number.isFinite(hours) || hours < 1 || hours > MAX_HOURS)
    throw Object.assign(new Error(`geomag_bad_hours: ${params.get('hours')}`), {
      status: 400,
    });
  return { id, hours: Math.floor(hours) };
}

async function fetchUpstream(fetchImpl, { id, hours, endMs }) {
  const url = buildDataUrl({ id, hours, endMs });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
    });
    if (!res.ok)
      throw Object.assign(new Error(`geomag_upstream_${res.status}`), {
        status: 502,
      });
    const text = await readResponseTextCapped(res, BODY_CAP_BYTES); // throws when too large
    const parsed = parseIaga2002(text); // throws {status:502} on bad shape
    return buildGeomagPayload(parsed, { id, hours, nowMs: endMs });
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res, status, body, cacheControl = 'public, max-age=300') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

async function getPayload(fetchImpl, query, nowMs, signal) {
  const key = `${query.id}:${query.hours}`;
  if (cache && cache.key === key && nowMs - cache.at < CACHE_TTL_MS)
    return {
      ...cache.payload,
      generatedAt: new Date(nowMs).toISOString(),
      stale: false,
    };
  signal?.throwIfAborted?.();
  if (!inflight || inflight.key !== key) {
    if (nowMs - attemptedAt < RETRY_COOLDOWN_MS)
      throw new Error('geomag_retry_later');
    attemptedAt = nowMs;
    const promise = fetchUpstream(fetchImpl, { ...query, endMs: nowMs })
      .then((payload) => {
        cache = { at: nowMs, key, payload };
        return payload;
      })
      .finally(() => {
        if (inflight?.key === key) inflight = null;
      });
    inflight = { key, promise };
  }
  const wait = inflight.promise;
  if (!signal) return wait;
  const cancelled = new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    const detach = () => signal.removeEventListener('abort', abort);
    wait.then(detach, detach);
  });
  return Promise.race([wait, cancelled]);
}

export function geomagUsgsProxy({
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
      let query;
      try {
        query = parseQuery(req.url);
        query.key = query.station
          ? `${query.station}:${query.minutes}`
          : `${query.id}:${query.hours}`;
      } catch (error) {
        return sendJson(
          res,
          400,
          { error: 'geomag_bad_request', detail: error.message },
          'no-store',
        );
      }
      try {
        const payload = await getPayload(
          fetchImpl,
          query,
          now(),
          controller.signal,
        );
        sendJson(res, 200, payload);
      } catch (error) {
        // Stale fallback is key-scoped: only serve a cache entry captured for THIS query.
        const usable =
          cache && cache.key === query.key && now() - cache.at <= STALE_MS;
        if (usable) {
          sendJson(res, 200, {
            ...cache.payload,
            generatedAt: new Date(now()).toISOString(),
            stale: true,
          });
          return;
        }
        const upstreamFail =
          error?.status === 502 ||
          error?.name === 'AbortError' ||
          /aborted?/i.test(error?.message ?? '');
        sendJson(
          res,
          upstreamFail ? 502 : 500,
          { error: 'geomag_unavailable', detail: error?.message ?? 'unknown' },
          'no-store',
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'geomagUsgs',
    configureServer({ middlewares }) {
      middlewares.use('/api/geomag-usgs', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/geomag-usgs', handler);
    },
  };
}

export const _geomagUsgsInternals = {
  DATA_URL,
  OBSERVATORIES,
  parseIaga2002,
  deriveHD,
  buildGeomagPayload,
  buildDataUrl,
  clearCaches: () => {
    cache = null;
    inflight = null;
    attemptedAt = -Infinity;
  },
};
