/**
 * Wave 9 — planetary vital signs: sea ice, ozone hole, spring phenology.
 *
 * Three independent keyless upstreams, three route proxies in one module
 * (tides.js multi-route precedent: kingTidesProxy / stormSurgeProxy):
 *
 *   /api/sea-ice   NSIDC Sea Ice Index G02135 v4.0 daily extent CSVs (N+S)
 *                  https://noaadata.apps.nsidc.org/NOAA/G02135/{north|south}/daily/data/{N|S}_seaice_extent_daily_v4.0.csv
 *   /api/ozone     NASA Ozone Watch annual maxima (ytd_data.txt)
 *                  https://ozonewatch.gsfc.nasa.gov/statistics/ytd_data.txt
 *   /api/phenology USA-NPN Spring Index leaf/bloom anomaly via GeoServer
 *                  WMS GetFeatureInfo (JSON) at pinned CONUS points
 *                  https://geoserver.usanpn.org/geoserver/wms
 *
 * All three verified 200 + real payloads from this VM 2026-10-03
 * (R2-23 build slot). No keys, no signups, nothing paid.
 *
 * HONESTY (per-lane blocks on every payload):
 * - sea ice: NASA Team algorithm, 15% concentration cutoff; near-real-time
 *   (AMSR2) values may be revised when final GSFC data lands. The
 *   day-of-year anomaly is computed against THIS FILE's full-record
 *   day-of-year mean — it is NOT the official 1981-2010 baseline NSIDC
 *   plots. Extent != thickness/volume.
 * - ozone: ANNUAL maxima only (one row per year: max daily hole area +
 *   min daily minimum ozone, with MMDD dates — the upstream header
 *   mislabels them "(YYMM)"). TOMS/OMI/OMPS with MERRA/MERRA-2/GEOS-FP
 *   fill; Southern Hemisphere; CC-BY. 1995 has no row upstream (absent,
 *   never synthesized).
 * - phenology: USA-NPN Extended Spring Indices are MODEL products
 *   (lilac/honeysuckle first-leaf/first-bloom), not station observations.
 *   Anomaly = days early(-)/late(+) vs the 30-year average layer at the
 *   same pixel. Each point is one WMS pixel sample; void/ocean pixels
 *   read null, never 0.
 */

export const USER_AGENT =
  'satyq-reality-os/1.0 (+https://satwq-reality-os.pages.dev)';
const UPSTREAM_TIMEOUT_MS = 20000;
const RETRY_COOLDOWN_MS = 60 * 1000;

export function numOrNull(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return null; // empty = missing, never 0 (Number('')===0)
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function fetchCapped(url, capBytes, accept = '*/*') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`vitals_upstream_${response.status}`), {
        status: 502,
      });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error('vitals_upstream_too_large'), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } catch (error) {
    if (error?.status === 502) throw error;
    throw Object.assign(
      new Error(`vitals_fetch_failed: ${error?.message ?? 'unknown'}`),
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

function makeCache() {
  const payloadCache = new Map();
  const inflight = new Map();
  let failedAt = -Infinity;
  return {
    payloadCache,
    inflight,
    get failedAt() {
      return failedAt;
    },
    set failedAt(v) {
      failedAt = v;
    },
  };
}

async function cachedGet(cache, key, ttlMs, staleMs, loader) {
  const now = Date.now();
  const hit = cache.payloadCache.get(key);
  if (hit && now - hit.at < ttlMs)
    return { payload: hit.payload, stale: false };
  let op = cache.inflight.get(key);
  if (!op) {
    if (
      now - cache.failedAt < RETRY_COOLDOWN_MS &&
      hit &&
      now - hit.at < staleMs
    ) {
      return { payload: hit.payload, stale: true };
    }
    op = (async () => {
      try {
        const payload = await loader();
        cache.payloadCache.set(key, { at: Date.now(), payload });
        return { payload, stale: false };
      } catch (error) {
        cache.failedAt = Date.now();
        if (hit && Date.now() - hit.at < staleMs)
          return { payload: hit.payload, stale: true };
        throw error;
      }
    })().finally(() => cache.inflight.delete(key));
    cache.inflight.set(key, op);
  }
  return op;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=300') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

function queryParams(req) {
  const host = req.headers?.host || 'localhost';
  const url = new URL(req.url || '/', `http://${host}`);
  return url.searchParams;
}

// ---------------------------------------------------------------------------
// SEA ICE — NSIDC G02135 v4.0 daily extent CSVs
// ---------------------------------------------------------------------------

const SEAICE_HONESTY = {
  algorithm:
    'NASA Team sea-ice algorithm, 15% concentration cutoff for extent. Values are satellite-derived extent, not thickness or volume.',
  nearRealTime:
    'Daily values are near-real-time (AMSR2); NSIDC revises them when final GSFC data lands (roughly yearly).',
  doyAnomaly:
    'The day-of-year anomaly is computed against THIS FILE\u2019s full-record day-of-year mean. It is NOT the official 1981-2010 baseline NSIDC uses in its plots.',
  units: 'Extent in millions of square kilometres (10^6 km^2).',
  nullsNeverZero: 'Missing values read null, never 0.',
  attribution:
    'Data: NSIDC Sea Ice Index G02135 v4.0 (NOAA@NSIDC), keyless public CSVs.',
};

const SEAICE_URLS = {
  north:
    'https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/N_seaice_extent_daily_v4.0.csv',
  south:
    'https://noaadata.apps.nsidc.org/NOAA/G02135/south/daily/data/S_seaice_extent_daily_v4.0.csv',
};
const SEAICE_TTL_MS = 24 * 3600 * 1000;
const SEAICE_STALE_MS = 14 * 24 * 3600 * 1000;
const SEAICE_BODY_CAP = 2_500_000; // ~1.9MB live; headroom for growth

const SEAICE_ROW_RE =
  /^\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*,\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)\s*,/;

/** Parse one hemisphere's CSV text into [{y,m,d,extent,missing}] (skips the 2 header rows). */
export function parseSeaIceCsv(text) {
  const rows = [];
  const lines = String(text).split('\n');
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const m = SEAICE_ROW_RE.exec(line);
    if (!m) continue;
    const extent = numOrNull(m[4]);
    const missing = numOrNull(m[5]);
    if (extent == null) continue;
    rows.push({
      y: Number(m[1]),
      m: Number(m[2]),
      d: Number(m[3]),
      extent,
      missing: missing ?? 0,
    });
  }
  return rows;
}

const isoDate = (r) =>
  `${r.y}-${String(r.m).padStart(2, '0')}-${String(r.d).padStart(2, '0')}`;
const doyKey = (r) => r.m * 100 + r.d;

/** Build the per-hemisphere payload section from parsed rows. */
export function buildSeaIceSection(hemi, rows) {
  if (!rows.length) return { hemi, ok: false, error: 'no_rows' };
  const latest = rows[rows.length - 1];
  const key = doyKey(latest);
  const same = rows.filter((r) => doyKey(r) === key);
  const exts = same.map((r) => r.extent);
  const mean = exts.reduce((a, b) => a + b, 0) / exts.length;
  let min = same[0];
  let max = same[0];
  for (const r of same) {
    if (r.extent < min.extent) min = r;
    if (r.extent > max.extent) max = r;
  }
  const series = rows
    .slice(-365)
    .map((r) => ({ date: isoDate(r), extent: r.extent }));
  return {
    hemi,
    ok: true,
    latest: {
      date: isoDate(latest),
      extentMkm2: latest.extent,
      missingMkm2: latest.missing,
    },
    dayOfYear: {
      month: latest.m,
      day: latest.d,
      recordMeanMkm2: Math.round(mean * 1000) / 1000,
      recordN: same.length,
      anomalyMkm2: Math.round((latest.extent - mean) * 1000) / 1000,
      recordMin: { value: min.extent, date: isoDate(min) },
      recordMax: { value: max.extent, date: isoDate(max) },
    },
    series365: series,
  };
}

const seaIceCache = makeCache();

async function getSeaIce(hemi) {
  return cachedGet(
    seaIceCache,
    hemi,
    SEAICE_TTL_MS,
    SEAICE_STALE_MS,
    async () => {
      const text = await fetchCapped(
        SEAICE_URLS[hemi],
        SEAICE_BODY_CAP,
        'text/csv, text/plain, */*',
      );
      const rows = parseSeaIceCsv(text);
      if (!rows.length)
        throw Object.assign(new Error('seaice_empty_parse'), { status: 502 });
      return buildSeaIceSection(hemi, rows);
    },
  );
}

/** Mount GET /api/sea-ice — NSIDC daily sea-ice extent, Arctic + Antarctic. */
export function seaIceProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    const q = queryParams(req);
    const hemi = (q.get('hemi') || 'both').toLowerCase();
    if (!['north', 'south', 'both', 'arctic', 'antarctic'].includes(hemi)) {
      return sendJson(
        res,
        400,
        { error: 'seaice_bad_hemi', honesty: SEAICE_HONESTY },
        'no-store',
      );
    }
    try {
      const hemis =
        hemi === 'both'
          ? ['north', 'south']
          : hemi === 'arctic'
            ? ['north']
            : hemi === 'antarctic'
              ? ['south']
              : [hemi];
      const sections = [];
      let anyStale = false;
      for (const h of hemis) {
        const { payload, stale } = await getSeaIce(h);
        anyStale = anyStale || stale;
        sections.push(payload);
      }
      sendJson(
        res,
        200,
        {
          generatedAt: new Date().toISOString(),
          upstream: Object.values(SEAICE_URLS),
          stale: anyStale,
          hemispheres: sections,
          honesty: SEAICE_HONESTY,
        },
        'public, max-age=3600',
      );
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'seaice_unavailable',
          detail: error?.message ?? 'unknown',
          honesty: SEAICE_HONESTY,
        },
        'no-store',
      );
    }
  }
  return {
    name: 'sea-ice',
    configureServer({ middlewares }) {
      middlewares.use('/api/sea-ice', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sea-ice', handler);
    },
  };
}

// ---------------------------------------------------------------------------
// OZONE — NASA Ozone Watch annual maxima (ytd_data.txt)
// ---------------------------------------------------------------------------

const OZONE_HONESTY = {
  annualOnly:
    'ANNUAL maxima only: one row per year (max daily ozone-hole area + min daily minimum ozone, with MMDD dates). This file does not carry daily values.',
  headerMislabel:
    'The upstream column header says "(YYMM)" but the values are MMDD (e.g. 0921 = September 21). Parsed as MMDD.',
  sources:
    'TOMS, OMI, and OMPS data; missing data filled from NASA GMAO MERRA, MERRA-2, and GEOS FP. Southern Hemisphere.',
  row1995: '1995 has no row in the upstream file (absent, never synthesized).',
  license: 'NASA Ozone Watch, CC-BY (https://science.data.nasa.gov/license/).',
  nullsNeverZero: 'Missing values read null, never 0.',
  attribution:
    'Data: NASA Ozone Watch (Goddard Space Flight Center), keyless public text.',
};

const OZONE_URL = 'https://ozonewatch.gsfc.nasa.gov/statistics/ytd_data.txt';
const OZONE_TTL_MS = 24 * 3600 * 1000;
const OZONE_STALE_MS = 90 * 24 * 3600 * 1000;

const OZONE_ROW_RE =
  /^\s*(\d{4})\s+(\d{4})\s+([0-9.]+)\s+(\d{4})\s+([0-9.]+)\s*$/;

function formatMmdd(y, mmdd) {
  const s = String(mmdd).padStart(4, '0');
  return `${y}-${s.slice(0, 2)}-${s.slice(2)}`;
}

/** Parse the ytd_data.txt annual table into [{year, areaDate, areaMkm2, ozoneDate, ozoneDU}]. */
export function parseOzoneYtd(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = OZONE_ROW_RE.exec(line);
    if (!m) continue;
    const year = Number(m[1]);
    rows.push({
      year,
      areaDate: formatMmdd(year, m[2]),
      areaMkm2: numOrNull(m[3]),
      ozoneDate: formatMmdd(year, m[4]),
      ozoneDU: numOrNull(m[5]),
    });
  }
  rows.sort((a, b) => a.year - b.year);
  return rows;
}

/** Build the ozone payload from parsed rows. */
export function buildOzonePayload(rows, stale) {
  const latest = rows[rows.length - 1];
  let recordArea = null;
  let recordOzone = null;
  for (const r of rows) {
    if (r.areaMkm2 != null && (!recordArea || r.areaMkm2 > recordArea.areaMkm2))
      recordArea = r;
    if (r.ozoneDU != null && (!recordOzone || r.ozoneDU < recordOzone.ozoneDU))
      recordOzone = r;
  }
  const decadeMeans = [];
  for (let start = 1980; start <= 2020; start += 10) {
    const inDec = rows.filter(
      (r) => r.year >= start && r.year < start + 10 && r.areaMkm2 != null,
    );
    if (inDec.length) {
      decadeMeans.push({
        decade: `${start}s`,
        n: inDec.length,
        meanAreaMkm2:
          Math.round(
            (inDec.reduce((a, r) => a + r.areaMkm2, 0) / inDec.length) * 10,
          ) / 10,
      });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    upstream: [OZONE_URL],
    stale: !!stale,
    latest: latest
      ? {
          year: latest.year,
          maxHoleArea: { valueMkm2: latest.areaMkm2, date: latest.areaDate },
          minOzone: { valueDU: latest.ozoneDU, date: latest.ozoneDate },
        }
      : null,
    records: {
      largestHole: recordArea
        ? {
            valueMkm2: recordArea.areaMkm2,
            date: recordArea.areaDate,
            year: recordArea.year,
          }
        : null,
      lowestOzone: recordOzone
        ? {
            valueDU: recordOzone.ozoneDU,
            date: recordOzone.ozoneDate,
            year: recordOzone.year,
          }
        : null,
    },
    decadeMeans,
    history: rows,
    honesty: OZONE_HONESTY,
  };
}

const ozoneCache = makeCache();

/** Mount GET /api/ozone — NASA Ozone Watch annual ozone-hole maxima. */
export function ozoneProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    const q = queryParams(req);
    const yearParam = q.get('year');
    if (yearParam != null && !/^\d{4}$/.test(yearParam)) {
      return sendJson(
        res,
        400,
        { error: 'ozone_bad_year', honesty: OZONE_HONESTY },
        'no-store',
      );
    }
    try {
      const { payload, stale } = await cachedGet(
        ozoneCache,
        'all',
        OZONE_TTL_MS,
        OZONE_STALE_MS,
        async () => {
          const text = await fetchCapped(OZONE_URL, 100_000, 'text/plain, */*');
          const rows = parseOzoneYtd(text);
          if (!rows.length)
            throw Object.assign(new Error('ozone_empty_parse'), {
              status: 502,
            });
          return buildOzonePayload(rows, false);
        },
      );
      const out = stale ? { ...payload, stale: true } : payload;
      if (yearParam != null) {
        const row = out.history.find((r) => r.year === Number(yearParam));
        if (!row) {
          return sendJson(res, 200, {
            generatedAt: out.generatedAt,
            stale: out.stale,
            requestedNotFound: true,
            year: Number(yearParam),
            latest: out.latest,
            honesty: OZONE_HONESTY,
          });
        }
        return sendJson(res, 200, {
          generatedAt: out.generatedAt,
          stale: out.stale,
          year: row,
          honesty: OZONE_HONESTY,
        });
      }
      sendJson(res, 200, out, 'public, max-age=3600');
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'ozone_unavailable',
          detail: error?.message ?? 'unknown',
          honesty: OZONE_HONESTY,
        },
        'no-store',
      );
    }
  }
  return {
    name: 'ozone',
    configureServer({ middlewares }) {
      middlewares.use('/api/ozone', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/ozone', handler);
    },
  };
}

// ---------------------------------------------------------------------------
// PHENOLOGY — USA-NPN Spring Index leaf/bloom anomaly (WMS GetFeatureInfo)
// ---------------------------------------------------------------------------

const PHENO_HONESTY = {
  modelNotObserved:
    'USA-NPN Extended Spring Indices are MODEL products (lilac/honeysuckle first-leaf/first-bloom phenology models driven by weather data), not direct station observations.',
  anomalyVs30yr:
    'Anomaly = days early (negative) or late (positive) relative to the 30-year-average layer at the same map pixel.',
  pixelSample:
    'Each point is a single WMS pixel sample at the pinned coordinates. Void/ocean pixels read null, never 0.',
  season:
    'Anomaly layers describe the current spring season; values freeze once the season completes.',
  nullsNeverZero: 'Missing values read null, never 0.',
  attribution:
    'Data: USA National Phenology Network (USA-NPN), keyless GeoServer WMS.',
};

const PHENO_WMS = 'https://geoserver.usanpn.org/geoserver/wms';
const PHENO_BBOX = [-125, 24, -66, 50];
const PHENO_W = 1180;
const PHENO_H = 520;
const PHENO_TTL_MS = 24 * 3600 * 1000;
const PHENO_STALE_MS = 7 * 24 * 3600 * 1000;

export const PHENO_POINTS = [
  { id: 'pembroke-va', label: 'Pembroke VA (home)', lat: 37.32, lon: -80.74 },
  { id: 'seattle-wa', label: 'Seattle WA', lat: 47.61, lon: -122.33 },
  { id: 'denver-co', label: 'Denver CO', lat: 39.74, lon: -104.99 },
  { id: 'minneapolis-mn', label: 'Minneapolis MN', lat: 44.98, lon: -93.27 },
  { id: 'austin-tx', label: 'Austin TX', lat: 30.27, lon: -97.74 },
  { id: 'miami-fl', label: 'Miami FL', lat: 25.76, lon: -80.19 },
];

/** Convert lon/lat to GetFeatureInfo pixel coords for the fixed map grid. */
export function lonLatToPixel(lon, lat) {
  const [x0, y0, x1, y1] = PHENO_BBOX;
  return {
    x: Math.round(((lon - x0) / (x1 - x0)) * PHENO_W),
    y: Math.round(((y1 - lat) / (y1 - y0)) * PHENO_H),
  };
}

function phenoFeatureUrl(layer, x, y) {
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1',
    request: 'GetFeatureInfo',
    layers: layer,
    query_layers: layer,
    srs: 'EPSG:4326',
    bbox: PHENO_BBOX.join(','),
    width: String(PHENO_W),
    height: String(PHENO_H),
    format: 'image/png',
    info_format: 'application/json',
    x: String(x),
    y: String(y),
  });
  return `${PHENO_WMS}?${params.toString()}`;
}

/** Extract the anomaly value (days) from a GetFeatureInfo JSON body. */
export function parsePhenoFeature(text, key) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const feat = body?.features?.[0];
  const raw = feat?.properties?.[key];
  return numOrNull(raw);
}

const phenoCache = makeCache();

async function getPhenoPoint(point) {
  return cachedGet(
    phenoCache,
    point.id,
    PHENO_TTL_MS,
    PHENO_STALE_MS,
    async () => {
      const { x, y } = lonLatToPixel(point.lon, point.lat);
      const leafText = await fetchCapped(
        phenoFeatureUrl('si-x:leaf_anomaly', x, y),
        50_000,
        'application/json',
      );
      const bloomText = await fetchCapped(
        phenoFeatureUrl('si-x:bloom_anomaly', x, y),
        50_000,
        'application/json',
      );
      const leafAnomalyDays = parsePhenoFeature(leafText, 'LEAF_OUT_DAY_DIFF');
      const bloomAnomalyDays = parsePhenoFeature(bloomText, 'BLOOM_DAY_DIFF');
      if (leafAnomalyDays == null && bloomAnomalyDays == null) {
        throw Object.assign(new Error('pheno_no_data_at_point'), {
          status: 502,
        });
      }
      return {
        id: point.id,
        label: point.label,
        lat: point.lat,
        lon: point.lon,
        ok: true,
        leafAnomalyDays,
        bloomAnomalyDays,
      };
    },
  );
}

/** Mount GET /api/phenology — USA-NPN spring leaf/bloom anomaly at pinned points. */
export function phenoProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    const q = queryParams(req);
    const pointParam = (q.get('point') || 'all').toLowerCase();
    try {
      const points =
        pointParam === 'all'
          ? PHENO_POINTS
          : PHENO_POINTS.filter((p) => p.id === pointParam);
      if (pointParam !== 'all' && !points.length) {
        if (!/^[a-z0-9-]{1,40}$/.test(pointParam)) {
          return sendJson(
            res,
            400,
            { error: 'pheno_bad_point', honesty: PHENO_HONESTY },
            'no-store',
          );
        }
        return sendJson(res, 200, {
          generatedAt: new Date().toISOString(),
          stale: false,
          requestedNotFound: true,
          point: pointParam,
          honesty: PHENO_HONESTY,
        });
      }
      const rows = [];
      let anyStale = false;
      let anyOk = false;
      for (const p of points) {
        try {
          const { payload, stale } = await getPhenoPoint(p);
          anyStale = anyStale || stale;
          anyOk = true;
          rows.push(payload);
        } catch (pointError) {
          rows.push({
            id: p.id,
            label: p.label,
            lat: p.lat,
            lon: p.lon,
            ok: false,
            error: pointError?.message ?? 'point_failed',
          });
        }
      }
      if (!anyOk) {
        return sendJson(
          res,
          502,
          { error: 'pheno_unavailable', points: rows, honesty: PHENO_HONESTY },
          'no-store',
        );
      }
      sendJson(
        res,
        200,
        {
          generatedAt: new Date().toISOString(),
          upstream: [PHENO_WMS],
          stale: anyStale,
          points: rows,
          honesty: PHENO_HONESTY,
        },
        'public, max-age=3600',
      );
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'pheno_unavailable',
          detail: error?.message ?? 'unknown',
          honesty: PHENO_HONESTY,
        },
        'no-store',
      );
    }
  }
  return {
    name: 'phenology',
    configureServer({ middlewares }) {
      middlewares.use('/api/phenology', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/phenology', handler);
    },
  };
}

export const _earthVitalsInternals = {
  SEAICE_URLS,
  OZONE_URL,
  PHENO_POINTS,
  SEAICE_HONESTY,
  OZONE_HONESTY,
  PHENO_HONESTY,
  parseSeaIceCsv,
  buildSeaIceSection,
  parseOzoneYtd,
  buildOzonePayload,
  lonLatToPixel,
  parsePhenoFeature,
  numOrNull,
  resetCaches: () => {
    for (const c of [seaIceCache, ozoneCache, phenoCache]) {
      c.payloadCache.clear();
      c.inflight.clear();
      c.failedAt = -Infinity;
    }
  },
};
