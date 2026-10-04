/**
 * Wave 3 / Track 2a.2 — NOAA National Water Model (NWPS) streamflow forecasts.
 *
 * WHY A PROXY: api.water.noaa.gov serves no CORS headers for browser use
 * (verified 2026-09-27 via curl headers), so the globe fetches through this
 * provider. One request fans out to the target reach plus its immediate
 * upstream/downstream neighbors (from the reach's own `route` block) to
 * build a short river ribbon with forecast flow at each node.
 *
 * Upstream: https://api.water.noaa.gov/nwps/v1/reaches/{comid}/streamflow
 * (DOC-VERIFIED 2026-09-27; live-verified on COMID 101, Neches River).
 * Keyless. No new dependencies; global fetch only; no node:* (Pages-safe).
 *
 * NOTE: series data only appears when ?series=<name> is passed; without it
 * the endpoint returns reach metadata with empty series objects.
 */
import { readResponseJsonCapped } from '../common/http.js';

const UPSTREAM = 'https://api.water.noaa.gov/nwps/v1/reaches';
const USER_AGENT =
  'satwq-reality-os/1.0 (NOAA NWPS public streamflow; contact via repo)';

const SERIES = [
  'short_range',
  'medium_range',
  'medium_range_blend',
  'long_range',
  'analysis_assimilation',
];
const SERIES_KEY = {
  short_range: 'shortRange',
  medium_range: 'mediumRange',
  medium_range_blend: 'mediumRangeBlend',
  long_range: 'longRange',
  analysis_assimilation: 'analysisAssimilation',
};
const CACHE_TTL_MS = 30 * 60_000; // NWM cycles run ~hourly
const STALE_MS = 6 * 60 * 60_000;
const RETRY_COOLDOWN_MS = 120_000;
const UPSTREAM_TIMEOUT_MS = 20_000;
const JSON_CAP = 2 * 1024 * 1024;
const MAX_COMIDS = 6;

/** Validate a comma-separated COMID list. Throws {status}. */
export function parseComids(raw) {
  const text = (raw ?? '').trim();
  if (!text)
    throw Object.assign(new Error('nwps_missing_comid'), { status: 400 });
  const ids = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0 || ids.length > MAX_COMIDS) {
    throw Object.assign(new Error('nwps_bad_comid_count'), { status: 400 });
  }
  for (const id of ids) {
    if (!/^\d{1,9}$/.test(id))
      throw Object.assign(new Error('nwps_bad_comid'), { status: 400 });
  }
  return [...new Set(ids)];
}

/** Validate the requested NWM series name. */
export function parseSeries(raw) {
  const name = (raw ?? 'short_range').trim();
  if (!SERIES.includes(name))
    throw Object.assign(new Error('nwps_bad_series'), { status: 400 });
  return name;
}

/** Normalize one reach document + its series into a ribbon node. */
export function parseReachNode(doc, series) {
  const reach = doc?.reach;
  if (!reach || typeof reach !== 'object')
    throw new Error('nwps_unexpected_shape');
  const lat = Number(reach.latitude);
  const lon = Number(reach.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon))
    throw new Error('nwps_bad_geometry');
  const key = SERIES_KEY[series];
  const seriesDoc = doc?.[key]?.series ?? null;
  const data = Array.isArray(seriesDoc?.data)
    ? seriesDoc.data
        .map((d) => ({
          validTime: d?.validTime ?? null,
          flow: Number(d?.flow),
        }))
        .filter(
          (d) => typeof d.validTime === 'string' && Number.isFinite(d.flow),
        )
    : [];
  let trendPct = null;
  let peakFlow = null;
  if (data.length >= 2) {
    const first = data[0].flow;
    const last = data[data.length - 1].flow;
    peakFlow = Math.max(...data.map((d) => d.flow));
    trendPct = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null;
  } else if (data.length === 1) {
    peakFlow = data[0].flow;
  }
  const route = reach.route ?? {};
  const neighbors = [
    ...(Array.isArray(route.upstream) ? route.upstream : []),
    ...(Array.isArray(route.downstream) ? route.downstream : []),
  ]
    .map((r) => String(r?.reachId ?? '').trim())
    .filter((id) => /^\d{1,9}$/.test(id));
  return {
    reachId: String(reach.reachId ?? ''),
    name: reach.name ?? `Reach ${reach.reachId ?? ''}`,
    lat,
    lon,
    referenceTime: seriesDoc?.referenceTime ?? null,
    units: seriesDoc?.units ?? 'ft3/s',
    series: data,
    trendPct,
    peakFlow,
    neighbors: [...new Set(neighbors)].slice(0, 4),
  };
}

function describe(value, { stale = false, reason = null } = {}) {
  return {
    schemaVersion: 1,
    source: 'NOAA National Water Model via local proxy',
    attribution:
      'Streamflow forecasts: NOAA National Water Service (public domain).',
    fetchedAt: value?.fetchedAt ?? null,
    stale,
    unavailable: !value,
    reason,
    series: value?.series ?? null,
    reaches: value?.reaches ?? [],
  };
}

export function nwpsProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  const attemptedAt = new Map();

  async function upstreamJson(url, signal) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`nwps_upstream_http_${response.status}`);
    }
    const doc = await readResponseJsonCapped(response, JSON_CAP, signal);
    signal.throwIfAborted();
    return doc;
  }

  /** Fetch a reach + its immediate neighbors (bounded fan-out). */
  async function fetchRibbon(comid, series, signal) {
    const seen = new Set([comid]);
    const root = parseReachNode(
      await upstreamJson(
        `${UPSTREAM}/${comid}/streamflow?series=${series}`,
        signal,
      ),
      series,
    );
    const nodes = [root];
    const neighborFetches = root.neighbors.slice(0, 4).map(async (nid) => {
      if (seen.has(nid)) return null;
      seen.add(nid);
      try {
        const doc = await upstreamJson(
          `${UPSTREAM}/${nid}/streamflow?series=${series}`,
          signal,
        );
        return parseReachNode(doc, series);
      } catch {
        return null; // one bad neighbor never kills the ribbon
      }
    });
    for (const node of await Promise.all(neighborFetches)) {
      if (node) nodes.push(node);
    }
    return nodes;
  }

  async function acquire(comids, series, signal) {
    const key = `${comids.join(',')}|${series}`;
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < CACHE_TTL_MS)
      return { value: hit.value, stale: false };
    signal.throwIfAborted();
    let op = inflight.get(key);
    if (!op) {
      if (now() - (attemptedAt.get(key) ?? -Infinity) < RETRY_COOLDOWN_MS) {
        throw new Error('nwps_retry_later');
      }
      attemptedAt.set(key, now());
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        timeoutMs * (1 + comids.length) + 5000,
      );
      op = (async () => {
        const reaches = [];
        for (const comid of comids) {
          reaches.push(
            ...(await fetchRibbon(comid, series, controller.signal)),
          );
        }
        const value = { series, reaches, fetchedAt: now() };
        if (cache.size >= 16) cache.delete(cache.keys().next().value);
        cache.set(key, { value, fetchedAt: now() });
        return { value, stale: false };
      })().finally(() => {
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
      let comids;
      let series;
      try {
        comids = parseComids(query.get('comid'));
        series = parseSeries(query.get('series'));
      } catch (error) {
        return json(error.status ?? 400, { error: error.message });
      }
      try {
        const { value, stale } = await acquire(
          comids,
          series,
          controller.signal,
        );
        json(200, describe(value, { stale }));
      } catch (error) {
        const key = `${comids.join(',')}|${series}`;
        const hit = cache.get(key);
        const usable = hit && now() - hit.fetchedAt <= STALE_MS;
        json(
          200,
          usable
            ? describe(hit.value, {
                stale: true,
                reason: 'NOAA NWPS unreachable; showing last good forecast.',
              })
            : describe(null, {
                reason: 'NOAA NWPS unreachable and no cached forecast exists.',
              }),
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'nwps',
    configureServer({ middlewares }) {
      middlewares.use('/api/nwps', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/nwps', handler);
    },
  };
}
