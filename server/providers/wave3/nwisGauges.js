/**
 * Wave 3 / Track 2a.1 — USGS gauge layer (WDFN API V1).
 *
 * WHY A PROXY: the frontend asks for "gauges in the current camera view" as
 * a bbox; this provider validates + quantizes the bbox, picks a trailing
 * history window sized to the bbox area (small view -> 2-day history for a
 * real per-gauge flow anomaly; whole-globe view -> latest-only, magnitude
 * only), and serves one compact JSON document at /api/nwis-gauges.
 *
 * Routes:
 *   GET /api/nwis-gauges?bbox=minLon,minLat,maxLon,maxLat  (default: CONUS)
 *   GET /api/nwis-gauges?sites=01646500,01463500            (site-ID mode)
 *   GET /api/rivers  — alias of the same sweep (catalog #89)
 *
 * Site-ID mode (added 2026-09-27, branch wave5-recur-stations): a curated
 * river ticker can request specific USGS gauges without drawing a bbox.
 * Every FEATURED_SITES ID was verified live 2026-09-27 against the NWIS
 * site service (https://waterservices.usgs.gov/nwis/site/?format=rdb&sites=…).
 * Sites mode fetches a P1D trailing window so the per-gauge z-score stays a
 * real trailing-window anomaly, exactly like bbox mode. A site that reports
 * no 00060/00065 values in the window is omitted — never synthesized.
 *
 * WDFN MIGRATION (2026-11-15, spec: sky-map-quest/registry/
 * WDFN-MIGRATION-2026-11-15.md): the upstream is now the WDFN API V1
 * (https://api.waterdata.usgs.gov/ogcapi/v1), keyless — WaterServices is
 * decommissioned in early 2027. Latest-only sweeps read the
 * `latest-continuous` collection; windowed sweeps read `continuous` with
 * an explicit datetime interval (the §3.1 history mapping). Station
 * names are joined from `monitoring-locations` (the §3.3 discovery
 * surface), because WDFN value features carry geometry but no name.
 * WDFN paginates with cursor `next` links at a default page of 10, so
 * every collection read follows pages up to a bounded feature budget.
 * No-data in WDFN is an absent feature OR a feature with value:null
 * (the latter observed in `continuous` for series IV flags -999999;
 * both are filtered — a null must never become a fabricated 0). One behavior
 * improvement over the legacy host, recorded in the migration record:
 * WaterServices rejected bboxes wider than ~1.1° (latitude-scaled) with
 * HTTP 400, so the legacy CONUS default sweep could never succeed;
 * WDFN accepts the full bbox range this provider validates.
 */
import { readResponseJsonCapped } from '../common/http.js';

const WDFN_BASE = 'https://api.waterdata.usgs.gov/ogcapi/v1/collections';
const USER_AGENT =
  'satwq-reality-os/1.0 (USGS WDFN public water data; contact via repo)';

const CACHE_TTL_MS = 15 * 60_000; // gauges move slowly; refresh at most every 15 min
const STALE_MS = 60 * 60_000;
const RETRY_COOLDOWN_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 25_000;
const JSON_CAP = 6 * 1024 * 1024; // per-page read cap (a limit=5000 page is ~3.5 MB)
const PAGE_LIMIT = 5000; // WDFN default page is 10 — always ask for a real page
const MAX_PAGES = 20; // cursor-follow bound across one collection read
const MAX_FEATURES = 80_000; // accumulated-feature budget (CONUS latest ≈ 26.5k)
const META_CHUNK = 100; // monitoring-locations numbers per name-join request
const MAX_GAUGES = 500; // compact output bound
const MAX_SITES = 20; // site-ID mode cap — keeps the upstream payload bounded
const MAX_CACHE_KEYS = 8;
const NO_DATA = -999999; // legacy NWIS no-data sentinel (defensive filter; WDFN omits instead)
const DEFAULT_BBOX = '-125,24,-66,50'; // CONUS fallback

/**
 * Curated major-river gauges for site-ID mode. IDs + coords are the REAL
 * NWIS site-service values (verified 2026-09-27 via the RDB site service);
 * names are the official station_nm from that same response. (Runtime
 * names now come from WDFN monitoring-locations; this list stays the
 * curated documentation of the featured set.)
 */
export const FEATURED_SITES = [
  {
    id: '01646500',
    name: 'Potomac River near Wash, DC Little Falls pump sta',
    lat: 38.94977778,
    lon: -77.12763889,
  },
  {
    id: '01463500',
    name: 'Delaware River at Trenton NJ',
    lat: 40.22166667,
    lon: -74.77805556,
  },
  {
    id: '07374000',
    name: 'Mississippi River at Baton Rouge, LA',
    lat: 30.44566667,
    lon: -91.1915556,
  },
  {
    id: '01578310',
    name: 'Susquehanna River at Conowingo, MD',
    lat: 39.65788889,
    lon: -76.17444444,
  },
  {
    id: '08057410',
    name: 'Trinity Rv bl Dallas, TX',
    lat: 32.70763139,
    lon: -96.7358319,
  },
  {
    id: '09380000',
    name: 'Colorado River at Lees Ferry, AZ',
    lat: 36.86433333,
    lon: -111.58787222,
  },
  {
    id: '14211720',
    name: 'Willamette River at Portland, OR',
    lat: 45.5175,
    lon: -122.6691667,
  },
  {
    id: '05586100',
    name: 'Illinois River at Valley City, IL',
    lat: 39.70319444,
    lon: -90.6430833,
  },
  {
    id: '06934500',
    name: 'Missouri River at Hermann, MO',
    lat: 38.70980556,
    lon: -91.4385,
  }, // verified 2026-09-27 recur
  {
    id: '03294500',
    name: 'OHIO RIVER AT LOUISVILLE, KY',
    lat: 38.28034736,
    lon: -85.7991305,
  }, // verified 2026-09-27 recur
  {
    id: '14105700',
    name: 'COLUMBIA RIVER AT THE DALLES, OR',
    lat: 45.60827778,
    lon: -121.1899167,
  }, // verified 2026-09-27 recur
  {
    id: '07263620',
    name: 'AR River@David D Terry L&D below Little Rock, AR',
    lat: 34.6811111,
    lon: -92.1513889,
  }, // verified 2026-09-27 recur
  {
    id: '08364000',
    name: 'RIO GRANDE AT EL PASO, TX',
    lat: 31.80288488,
    lon: -106.5408218,
  }, // verified 2026-09-27 recur
  {
    id: '11447650',
    name: 'SACRAMENTO R A FREEPORT CA',
    lat: 38.45566389,
    lon: -121.5016167,
  }, // verified 2026-09-27 recur
  {
    id: '07032000',
    name: 'Mississippi River at Memphis, TN',
    lat: 35.12314616,
    lon: -90.077592,
  }, // verified 2026-09-28 recur
  {
    id: '06329500',
    name: 'Yellowstone River near Sidney MT',
    lat: 47.67741389,
    lon: -104.1554111,
  }, // verified 2026-09-28 recur
  {
    id: '07301500',
    name: 'North Fork Red River near Carter, OK',
    lat: 35.16810838,
    lon: -99.5073128,
  }, // verified 2026-09-28 recur
  {
    id: '13037500',
    name: 'SNAKE RIVER NR HEISE ID',
    lat: 43.6125,
    lon: -111.66,
  }, // verified 2026-09-28 recur
  {
    id: '03598000',
    name: 'DUCK RIVER NEAR SHELBYVILLE, TN',
    lat: 35.48035,
    lon: -86.4991609,
  }, // verified 2026-09-28 recur
  {
    id: '05587450',
    name: 'Mississippi River at Grafton, IL',
    lat: 38.9679722,
    lon: -90.429,
  }, // verified 2026-09-28 recur (live IV 00060 211000 cfs 2026-09-28)
];
// PARKED (real site, verified via NWIS rdb, but IV-dark at verification — never list a dead station):
// 03609750 TENNESSEE RIVER AT HIGHWAY 60 NEAR PADUCAH, KY (37.03783498,-88.5294898) — zero IV series on 2026-09-28

/** Parse + validate a comma-separated "sites=" list of USGS site numbers. Throws (400). */
export function parseSites(raw) {
  const ids = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0 || ids.length > MAX_SITES) {
    throw Object.assign(new Error(`nwis_sites_count:${ids.length}`), {
      status: 400,
    });
  }
  for (const id of ids) {
    if (!/^\d{4,15}$/.test(id)) {
      throw Object.assign(new Error(`nwis_bad_site:${id.slice(0, 24)}`), {
        status: 400,
      });
    }
  }
  return [...new Set(ids)];
}

/** Parse + validate a "minLon,minLat,maxLon,maxLat" bbox string. Throws. */
export function parseBbox(raw) {
  const text = (raw ?? DEFAULT_BBOX).trim();
  const parts = text.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw Object.assign(new Error('nwis_bad_bbox'), { status: 400 });
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
    throw Object.assign(new Error('nwis_bbox_out_of_range'), { status: 400 });
  }
  if (!(minLon < maxLon) || !(minLat < maxLat)) {
    throw Object.assign(new Error('nwis_bbox_inverted'), { status: 400 });
  }
  if (maxLon - minLon > 70 || maxLat - minLat > 40) {
    throw Object.assign(new Error('nwis_bbox_too_large'), { status: 400 });
  }
  return { minLon, minLat, maxLon, maxLat };
}

/** Quantize for cache keys so camera jitter doesn't bust the cache. */
export function quantizeBbox(b) {
  const q = (v) => Math.round(v * 2) / 2;
  return [q(b.minLon), q(b.minLat), q(b.maxLon), q(b.maxLat)].join(',');
}

/**
 * Choose the trailing history window by bbox area. Small areas can afford
 * the 15-min values needed for a real per-gauge anomaly; a continental
 * view gets latest-only (tiny payload, magnitude only).
 * Returns 'P2D' | 'P1D' | null (null = latest only).
 */
export function anomalyPeriod(bbox) {
  const area = (bbox.maxLon - bbox.minLon) * (bbox.maxLat - bbox.minLat);
  if (area <= 2) return 'P2D';
  if (area <= 8) return 'P1D';
  return null;
}

/** z-score of the last value vs the trailing window. */
export function trailingZ(values) {
  const xs = values.filter((v) => Number.isFinite(v) && v !== NO_DATA);
  if (xs.length < 3) return { z: 0, n: xs.length, mean: xs[0] ?? null };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(
    xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length,
  );
  const last = xs[xs.length - 1];
  return { z: sd > 0 ? (last - mean) / sd : 0, n: xs.length, mean };
}

/** Bare site number from a WDFN monitoring_location_id ("USGS-03176500" -> "03176500"). */
export function bareSiteNumber(monitoringLocationId) {
  return String(monitoringLocationId ?? '').replace(/^[A-Za-z][A-Za-z0-9]*-/, '');
}

/**
 * Parse WDFN GeoJSON features (latest-continuous or continuous) into
 * gauge records, or throw on a non-array. Features accumulate per site
 * across the two parameter codes so one site yields one gauge. When a
 * site carries several time series for one parameter, the instantaneous
 * statistic (00011, per the migration spec §3.2) wins; otherwise the
 * longest series wins. `name` starts as the bare site number — the
 * fetch path overwrites it from monitoring-locations (value features
 * carry no name); a gauge whose name was never resolved keeps the
 * number, visibly, never a fabricated name.
 */
export function parseWdfnPayload(features, { maxGauges = MAX_GAUGES } = {}) {
  if (!Array.isArray(features)) throw new Error('nwis_unexpected_shape');
  const sites = new Map();
  for (const feature of features) {
    const p = feature?.properties;
    if (!p) continue;
    const code = p.parameter_code;
    if (code !== '00060' && code !== '00065') continue;
    const siteCode = bareSiteNumber(p.monitoring_location_id);
    if (!siteCode) continue;
    const coords = feature?.geometry?.coordinates;
    const lon = Number(coords?.[0]);
    const lat = Number(coords?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // WDFN spells no-data as value:null (observed live 2026-11-15 on
    // gauge 03052500, whose IV series is all -999999): Number(null)===0
    // would fabricate a 0 reading, so null/blank is filtered BEFORE the
    // numeric conversion — the numOrNull discipline from generic.js.
    const value =
      p.value == null || (typeof p.value === 'string' && p.value.trim() === '')
        ? NaN
        : Number(p.value);
    if (!Number.isFinite(value) || value === NO_DATA) continue;
    const timeMs = Date.parse(p.time);
    if (!Number.isFinite(timeMs)) continue;
    let site = sites.get(siteCode);
    if (!site) {
      site = {
        id: siteCode,
        name: siteCode,
        lat,
        lon,
        flowCfs: null,
        flowZ: 0,
        flowN: 0,
        heightFt: null,
        heightZ: 0,
        timeMs: null,
        series: new Map(), // `${code}|${time_series_id}` -> { statistic, vals: [{t, v}] }
      };
      sites.set(siteCode, site);
    }
    const key = `${code}|${p.time_series_id ?? ''}`;
    let series = site.series.get(key);
    if (!series) {
      series = { statistic: p.statistic_id ?? null, vals: [] };
      site.series.set(key, series);
    }
    series.vals.push({ t: timeMs, v: value });
  }
  const gauges = [];
  for (const site of sites.values()) {
    for (const code of ['00060', '00065']) {
      const candidates = [...site.series.entries()]
        .filter(([key]) => key.startsWith(`${code}|`))
        .map(([, series]) => series)
        .sort(
          (a, b) =>
            (b.statistic === '00011') - (a.statistic === '00011') ||
            b.vals.length - a.vals.length,
        );
      const chosen = candidates[0];
      if (!chosen) continue;
      const vals = chosen.vals.sort((a, b) => a.t - b.t);
      const values = vals.map((x) => x.v);
      const { z, n } = trailingZ(values);
      const last = vals[vals.length - 1];
      if (code === '00060') {
        site.flowCfs = last.v;
        site.flowZ = z;
        site.flowN = n;
      } else {
        site.heightFt = last.v;
        site.heightZ = z;
      }
      if (site.timeMs == null || last.t > site.timeMs) site.timeMs = last.t;
    }
    delete site.series;
    gauges.push(site);
  }
  return gauges.slice(0, maxGauges);
}

function describe(value, { stale = false, reason = null } = {}) {
  return {
    schemaVersion: 1,
    source: 'USGS WDFN (Water Data for the Nation) via local proxy',
    attribution: 'Streamflow data: U.S. Geological Survey (public domain).',
    fetchedAt: value?.fetchedAt ?? null,
    stale,
    unavailable: !value,
    reason,
    bbox: value?.bbox ?? null,
    sites: value?.sites ?? null,
    anomalyBasis: value?.anomalyBasis ?? null,
    gauges: value?.gauges ?? [],
    count: value?.gauges?.length ?? 0,
  };
}

export function nwisGaugesProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  const cache = new Map(); // key -> { value, fetchedAt }
  const inflight = new Map(); // key -> promise
  const attemptedAt = new Map(); // key -> ts

  function cacheSet(key, value) {
    if (cache.size >= MAX_CACHE_KEYS) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(key, { value, fetchedAt: now() });
  }

  /** One WDFN page -> parsed GeoJSON doc (capped read, honest errors). */
  async function fetchPage(url, signal) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json, application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`nwis_upstream_http_${response.status}`);
    }
    const doc = await readResponseJsonCapped(response, JSON_CAP, signal);
    signal.throwIfAborted();
    if (!Array.isArray(doc?.features)) throw new Error('nwis_unexpected_shape');
    return doc;
  }

  /** Follow cursor `next` links until the collection is exhausted or the budget is hit. */
  async function fetchFeatures(firstUrl, signal) {
    const features = [];
    let url = firstUrl;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const doc = await fetchPage(url, signal);
      features.push(...doc.features);
      if (features.length > MAX_FEATURES)
        throw new Error('nwis_upstream_too_large');
      url = doc.links?.find((link) => link?.rel === 'next')?.href ?? null;
    }
    if (url) throw new Error('nwis_upstream_too_large'); // pages remain past the bound
    return features;
  }

  /**
   * Name join via monitoring-locations (migration spec §3.3): bare site
   * number -> official station name. Chunked CSV queries, settled in
   * parallel; a failed chunk just leaves those gauges numbered.
   */
  async function fetchSiteNames(numbers, signal) {
    const names = new Map();
    const unique = [...new Set(numbers)].filter(Boolean);
    const chunks = [];
    for (let i = 0; i < unique.length; i += META_CHUNK)
      chunks.push(unique.slice(i, i + META_CHUNK));
    const settled = await Promise.allSettled(
      chunks.map(async (chunk) => {
        const url = `${WDFN_BASE}/monitoring-locations/items?monitoring_location_number=${chunk.join(',')}&limit=1000`;
        const doc = await fetchPage(url, signal);
        for (const feature of doc.features) {
          const number = feature?.properties?.monitoring_location_number;
          const name = feature?.properties?.monitoring_location_name;
          if (number && typeof name === 'string' && name.trim())
            names.set(String(number), name.trim());
        }
      }),
    );
    void settled;
    return names;
  }

  async function fetchUpstream({ bbox, sites, period, signal }) {
    // Windowed sweeps read the `continuous` collection over an explicit
    // datetime interval; latest-only sweeps read `latest-continuous`
    // (migration spec §3.1). Both are one Feature per observation.
    const collection = period ? 'continuous' : 'latest-continuous';
    const params = new URLSearchParams({
      parameter_code: '00060,00065',
      limit: String(PAGE_LIMIT),
    });
    if (sites) {
      params.set('monitoring_location_number', sites.join(','));
    } else {
      params.set(
        'bbox',
        `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
      );
    }
    if (period) {
      const endMs = now();
      const startMs = endMs - (period === 'P2D' ? 2 : 1) * 24 * 3600_000;
      params.set(
        'datetime',
        `${new Date(startMs).toISOString()}/${new Date(endMs).toISOString()}`,
      );
    }
    const url = `${WDFN_BASE}/${collection}/items?${params.toString()}`;
    const features = await fetchFeatures(url, signal);
    const gauges = parseWdfnPayload(features);
    // Names: sites mode resolves the requested list; bbox mode resolves
    // exactly the gauges that survived the output slice.
    const names = await fetchSiteNames(
      sites ?? gauges.map((gauge) => gauge.id),
      signal,
    ).catch(() => new Map());
    for (const gauge of gauges) {
      const name = names.get(gauge.id);
      if (name) gauge.name = name;
    }
    return {
      bbox: sites
        ? null
        : `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
      sites: sites ? [...sites] : null,
      anomalyBasis: period
        ? `trailing ${period} z-score per gauge`
        : 'latest-only (magnitude, no anomaly)',
      gauges,
      fetchedAt: now(),
    };
  }

  async function acquire({ bbox, sites }, signal) {
    // Sites mode always carries a P1D trailing window so the z-score is a
    // real per-gauge anomaly; bbox mode sizes the window by area as before.
    const period = sites ? 'P1D' : anomalyPeriod(bbox);
    const key = sites
      ? `sites:${sites.join(',')}|P1D`
      : `${quantizeBbox(bbox)}|${period ?? 'latest'}`;
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < CACHE_TTL_MS)
      return { value: hit.value, stale: false };
    signal.throwIfAborted();
    let op = inflight.get(key);
    if (!op) {
      if (now() - (attemptedAt.get(key) ?? -Infinity) < RETRY_COOLDOWN_MS) {
        throw new Error('nwis_retry_later');
      }
      attemptedAt.set(key, now());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);
      op = fetchUpstream({ bbox, sites, period, signal: controller.signal })
        .then((value) => {
          cacheSet(key, value);
          return { value, stale: false };
        })
        .finally(() => {
          clearTimeout(timer);
          inflight.delete(key);
        });
      inflight.set(key, op);
    }
    const cancelled = new Promise((_, reject) => {
      const abort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      const detach = () => signal.removeEventListener('abort', abort);
      op.then(detach, detach); // both branches resolve: never an unhandled rejection
    });
    return Promise.race([op, cancelled]);
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' });
      const query = new URL(req.url, 'http://localhost').searchParams;
      // Site-ID mode (?sites=) takes precedence; otherwise fall back to the
      // bbox sweep (default: CONUS).
      const sitesRaw = query.get('sites');
      let sites = null;
      let bbox = null;
      try {
        if (sitesRaw != null && sitesRaw.trim() !== '') {
          sites = parseSites(sitesRaw);
        } else {
          bbox = parseBbox(query.get('bbox'));
        }
      } catch (error) {
        return json(error.status ?? 400, { error: error.message });
      }
      try {
        const { value, stale } = await acquire(
          { bbox, sites },
          controller.signal,
        );
        json(200, describe(value, { stale }));
      } catch (error) {
        // Same cache-key shape as acquire(): sites mode is pinned to P1D,
        // bbox mode uses the quantized bbox + area-sized period.
        const key = sites
          ? `sites:${sites.join(',')}|P1D`
          : `${quantizeBbox(bbox)}|${anomalyPeriod(bbox) ?? 'latest'}`;
        const hit = cache.get(key);
        const usable = hit && now() - hit.fetchedAt <= STALE_MS;
        json(
          200,
          usable
            ? describe(hit.value, {
                stale: true,
                reason: 'USGS unreachable; showing last good sweep.',
              })
            : describe(null, {
                reason: 'USGS WDFN unreachable and no cached sweep exists.',
              }),
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'nwis-gauges',
    configureServer({ middlewares }) {
      middlewares.use('/api/nwis-gauges', handler);
      // Wave 5 (catalog #89): /api/rivers is an alias of the same sweep —
      // the gauge record already carries discharge (00060) + gage height
      // (00065), so a separate provider would only duplicate the upstream.
      middlewares.use('/api/rivers', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/nwis-gauges', handler);
      middlewares.use('/api/rivers', handler);
    },
  };
}
