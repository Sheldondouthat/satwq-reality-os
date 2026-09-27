/**
 * Wave 3 / Track 2a.1 — USGS NWIS instantaneous-values gauge layer.
 *
 * WHY A PROXY: the frontend asks for "gauges in the current camera view" as
 * a bbox; this provider validates + quantizes the bbox, picks a trailing
 * history window sized to the bbox area (small view -> 2-day history for a
 * real per-gauge flow anomaly; whole-globe view -> latest-only, magnitude
 * only), and serves one compact JSON document at /api/nwis-gauges.
 *
 * Upstream: https://waterservices.usgs.gov/nwis/iv/?format=json (WaterML
 * JSON). Keyless, public domain (U.S. Geological Survey). No new
 * dependencies; global fetch only; no node:* imports (Pages-safe).
 *
 * Flow "anomaly" is a trailing-window z-score of the gauge's OWN recent
 * values (mean/std of the fetched window), NOT a flood-stage comparison —
 * the client legend must say so (see INTEGRATION.md honesty note).
 */
import { readResponseJsonCapped } from '../common/http.js';

const UPSTREAM = 'https://waterservices.usgs.gov/nwis/iv/';
const USER_AGENT =
  'satwq-reality-os/1.0 (USGS NWIS public instantaneous values; contact via repo)';

const CACHE_TTL_MS = 15 * 60_000; // gauges move slowly; refresh at most every 15 min
const STALE_MS = 60 * 60_000;
const RETRY_COOLDOWN_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 25_000;
const JSON_CAP = 6 * 1024 * 1024;
const MAX_GAUGES = 500; // compact output bound
const MAX_CACHE_KEYS = 8;
const NO_DATA = -999999; // NWIS no-data sentinel
const DEFAULT_BBOX = '-125,24,-66,50'; // CONUS fallback

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
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length);
  const last = xs[xs.length - 1];
  return { z: sd > 0 ? (last - mean) / sd : 0, n: xs.length, mean };
}

/**
 * Parse one WaterML timeSeries into a gauge record, or null to skip.
 * seriesMap accumulates per-site { flow: {...}, height: {...} } across
 * the two parameter codes so one site yields one gauge.
 */
export function parseNwisPayload(doc, { maxGauges = MAX_GAUGES } = {}) {
  const series = doc?.value?.timeSeries;
  if (!Array.isArray(series)) throw new Error('nwis_unexpected_shape');
  const sites = new Map();
  for (const ts of series) {
    if (sites.size >= maxGauges * 2 && !sites.has(siteIdOf(ts))) {
      // keep scanning cheap: hard stop once well past the cap
      if (sites.size >= maxGauges * 3) break;
    }
    const info = ts?.sourceInfo;
    const geo = info?.geoLocation?.geogLocation;
    const lat = Number(geo?.latitude);
    const lon = Number(geo?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const code = ts?.variable?.variableCode?.[0]?.value;
    if (code !== '00060' && code !== '00065') continue;
    const siteCode = info?.siteCode?.[0]?.value ?? `${lat},${lon}`;
    const rawValues = ts?.values?.[0]?.value ?? [];
    const vals = rawValues
      .map((v) => Number(v?.value))
      .filter((v) => Number.isFinite(v) && v !== NO_DATA);
    if (vals.length === 0) continue;
    const last = rawValues[rawValues.length - 1];
    const timeMs = Date.parse(last?.dateTime);
    let site = sites.get(siteCode);
    if (!site) {
      site = {
        id: siteCode,
        name: info?.siteName ?? siteCode,
        lat,
        lon,
        flowCfs: null,
        flowZ: 0,
        flowN: 0,
        heightFt: null,
        heightZ: 0,
        timeMs: Number.isFinite(timeMs) ? timeMs : null,
      };
      sites.set(siteCode, site);
    }
    const { z, n } = trailingZ(vals);
    if (code === '00060') {
      site.flowCfs = vals[vals.length - 1];
      site.flowZ = z;
      site.flowN = n;
    } else {
      site.heightFt = vals[vals.length - 1];
      site.heightZ = z;
    }
    if (Number.isFinite(timeMs) && (site.timeMs == null || timeMs > site.timeMs)) {
      site.timeMs = timeMs;
    }
  }
  return [...sites.values()].slice(0, maxGauges);
}

function siteIdOf(ts) {
  return ts?.sourceInfo?.siteCode?.[0]?.value ?? '';
}

function describe(value, { stale = false, reason = null } = {}) {
  return {
    schemaVersion: 1,
    source: 'USGS NWIS instantaneous values via local proxy',
    attribution: 'Streamflow data: U.S. Geological Survey (public domain).',
    fetchedAt: value?.fetchedAt ?? null,
    stale,
    unavailable: !value,
    reason,
    bbox: value?.bbox ?? null,
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

  async function fetchUpstream(bbox, period, signal) {
    const params = new URLSearchParams({
      format: 'json',
      bBox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
      parameterCd: '00060,00065',
    });
    if (period) params.set('period', period);
    const url = `${UPSTREAM}?${params.toString()}`;
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`nwis_upstream_http_${response.status}`);
    }
    const doc = await readResponseJsonCapped(response, JSON_CAP, signal);
    signal.throwIfAborted();
    const gauges = parseNwisPayload(doc);
    return {
      bbox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
      anomalyBasis: period ? `trailing ${period} z-score per gauge` : 'latest-only (magnitude, no anomaly)',
      gauges,
      fetchedAt: now(),
    };
  }

  async function acquire(bbox, signal) {
    const period = anomalyPeriod(bbox);
    const key = `${quantizeBbox(bbox)}|${period ?? 'latest'}`;
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < CACHE_TTL_MS) return { value: hit.value, stale: false };
    signal.throwIfAborted();
    let op = inflight.get(key);
    if (!op) {
      if (now() - (attemptedAt.get(key) ?? -Infinity) < RETRY_COOLDOWN_MS) {
        throw new Error('nwis_retry_later');
      }
      attemptedAt.set(key, now());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);
      op = fetchUpstream(bbox, period, controller.signal)
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
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
      const query = new URL(req.url, 'http://localhost').searchParams;
      let bbox;
      try {
        bbox = parseBbox(query.get('bbox'));
      } catch (error) {
        return json(error.status ?? 400, { error: error.message });
      }
      try {
        const { value, stale } = await acquire(bbox, controller.signal);
        json(200, describe(value, { stale }));
      } catch (error) {
        const key = `${quantizeBbox(bbox)}|${anomalyPeriod(bbox) ?? 'latest'}`;
        const hit = cache.get(key);
        const usable = hit && now() - hit.fetchedAt <= STALE_MS;
        json(
          200,
          usable
            ? describe(hit.value, { stale: true, reason: 'USGS unreachable; showing last good sweep.' })
            : describe(null, { reason: 'USGS NWIS unreachable and no cached sweep exists.' }),
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
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/nwis-gauges', handler);
    },
  };
}
