/**
 * INTERMAGNET HAPI geomagnetic provider (keyless).
 *
 * Upstream: https://imag-data.bgs.ac.uk/GIN_V1/hapi (HAPI 3.1, DOC-VERIFIED
 * 2026-09-27). Global observatory time series; per-observatory dataset ids
 * like `ott/best-avail/PT1M/xyzf` expose `Time` + `Field_Magnitude` (nT).
 *
 * Physics honesty: `anomalyNT` is DERIVED — latest 1-min scalar field minus
 * the median of the preceding 2 h at the same observatory. It is a
 * short-window disturbance index for a shimmer layer, NOT a storm scale and
 * NOT a substitute for Kp/Dst. Baselines drift with secular variation; the
 * 2 h median is a local, relative reference only.
 *
 * Consumer contract:
 *   GET /api/geomag → JSON
 *   {
 *     fetchedAt, windowMin: 120, ttlMs, stale,
 *     observatories: [{
 *       code, name, lat, lon, dataset,
 *       latest: { t, f } | null,   // f in nT
 *       medianF, anomalyNT, samples, status: 'ok'|'nodata'|'error'
 *     }],
 *     unavailable, reason
 *   }
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, no node: imports, no WASM).
 */

const HAPI_BASE = 'https://imag-data.bgs.ac.uk/GIN_V1/hapi';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 256 * 1024;
const USER_AGENT = 'SATWQ Reality OS (public INTERMAGNET context)';
const CACHE_TTL_MS = 10 * 60 * 1000;
const INFO_TTL_MS = 24 * 60 * 60 * 1000;
const WINDOW_MIN = 120;

/**
 * Curated INTERMAGNET observatories (IAGA codes + published coordinates).
 */
const OBSERVATORIES = [
  { code: 'ott', name: 'Ottawa', lat: 45.403, lon: -75.552 },
  { code: 'ngk', name: 'Niemegk', lat: 52.072, lon: 12.675 },
  { code: 'her', name: 'Hermanus', lat: -34.425, lon: 19.225 },
  { code: 'kak', name: 'Kakioka', lat: 36.232, lon: 140.186 },
  { code: 'hon', name: 'Honolulu', lat: 21.32, lon: -158.0 },
  { code: 'aae', name: 'Addis Ababa', lat: 9.035, lon: 38.766 },
  { code: 'mbo', name: "M'bour", lat: 14.392, lon: -16.958 },
  { code: 'esk', name: 'Eskdalemuir', lat: 55.314, lon: -3.206 },
];

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': status === 200 ? 'public, max-age=300' : 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function fetchJsonCapped(fetchImpl, url, maxBytes, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`geomag_upstream_${response.status}`), {
        status: 502,
      });
    const text = await response.text();
    if (text.length > maxBytes)
      throw Object.assign(new Error('geomag_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** True when the HAPI envelope signals success (code 1200). */
export function hapiOk(envelope) {
  return Boolean(
    envelope && envelope.status && Number(envelope.status.code) === 1200,
  );
}

/**
 * Normalize one observatory's HAPI /data rows ([time, F]) into the
 * consumer-contract row. Pure function — unit-tested with fixtures.
 */
export function normalizeObservatory(obs, rows) {
  const base = {
    code: obs.code.toUpperCase(),
    name: obs.name,
    lat: obs.lat,
    lon: obs.lon,
    dataset: `${obs.code}/best-avail/PT1M/xyzf`,
  };
  const clean = (rows || [])
    .filter((r) => Array.isArray(r) && r.length >= 2 && Number.isFinite(r[1]))
    .map((r) => ({ t: String(r[0]), f: r[1] }));
  if (!clean.length)
    return {
      ...base,
      latest: null,
      medianF: null,
      anomalyNT: null,
      samples: 0,
      status: 'nodata',
    };
  const fs = clean.map((r) => r.f).sort((a, b) => a - b);
  const mid = Math.floor(fs.length / 2);
  const medianF = fs.length % 2 ? fs[mid] : (fs[mid - 1] + fs[mid]) / 2;
  const latest = clean[clean.length - 1];
  return {
    ...base,
    latest: { t: latest.t, f: Math.round(latest.f * 100) / 100 },
    medianF: Math.round(medianF * 100) / 100,
    anomalyNT: Math.round((latest.f - medianF) * 100) / 100,
    samples: clean.length,
    status: 'ok',
  };
}

export function intermagnetProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  let cache = null;
  const infoCache = new Map(); // dataset -> { at, stopDate }

  async function datasetStop(dataset) {
    const now = Date.now();
    const hit = infoCache.get(dataset);
    if (hit && now - hit.at < INFO_TTL_MS) return hit.stopDate;
    const info = await fetchJsonCapped(
      fetchImpl,
      `${HAPI_BASE}/info?dataset=${encodeURIComponent(dataset)}`,
      BODY_CAP_BYTES,
      UPSTREAM_TIMEOUT_MS,
    );
    if (!hapiOk(info) || !info.stopDate)
      throw Object.assign(new Error('geomag_info_unavailable'), {
        status: 502,
      });
    infoCache.set(dataset, { at: now, stopDate: info.stopDate });
    return info.stopDate;
  }

  async function fetchObservatory(obs) {
    const dataset = `${obs.code}/best-avail/PT1M/xyzf`;
    try {
      const stop = await datasetStop(dataset);
      const stopMs = Date.parse(stop);
      const startIso = new Date(stopMs - WINDOW_MIN * 60_000).toISOString();
      const data = await fetchJsonCapped(
        fetchImpl,
        `${HAPI_BASE}/data?dataset=${encodeURIComponent(
          dataset,
        )}&parameters=Time,Field_Magnitude&start=${encodeURIComponent(
          startIso,
        )}&stop=${encodeURIComponent(stop)}&format=json`,
        BODY_CAP_BYTES,
        UPSTREAM_TIMEOUT_MS,
      );
      if (!hapiOk(data))
        return { ...normalizeObservatory(obs, []), status: 'error' };
      return normalizeObservatory(obs, data.data);
    } catch {
      return {
        ...normalizeObservatory(obs, []),
        status: 'error',
      };
    }
  }

  async function getSnapshot() {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS)
      return { ...cache.payload, stale: false };
    const results = await Promise.allSettled(
      OBSERVATORIES.map((o) => fetchObservatory(o)),
    );
    const observatories = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { ...normalizeObservatory(OBSERVATORIES[i], []), status: 'error' },
    );
    const anyOk = observatories.some((o) => o.status === 'ok');
    if (!anyOk && observatories.length) {
      if (cache) return { ...cache.payload, stale: true };
      throw Object.assign(new Error('geomag_upstream_unavailable'), {
        status: 502,
      });
    }
    const payload = {
      fetchedAt: now,
      windowMin: WINDOW_MIN,
      ttlMs: CACHE_TTL_MS,
      stale: false,
      observatories,
      unavailable: false,
      reason: null,
    };
    cache = { at: now, payload };
    return payload;
  }

  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' });
    try {
      sendJson(res, 200, await getSnapshot());
    } catch {
      sendJson(res, 502, { error: 'geomag_upstream_unavailable' });
    }
  }

  return {
    name: 'intermagnet',
    configureServer({ middlewares }) {
      middlewares.use('/api/geomag', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/geomag', handler);
    },
  };
}
