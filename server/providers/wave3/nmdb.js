/**
 * NMDB neutron-monitor provider (keyless).
 *
 * Upstream: NMDB NEST real-time ASCII service, https://www.nmdb.eu/nest/
 *   draw_graph.php?formchk=1&stations[]=<CODE>&output=ascii&tabchoice=revori
 *   &dtype=corr_for_efficiency&date_choice=last&lastndays=<N>
 * Public, keyless, no CORS-safe JSON — so the browser cannot consume it
 * directly; this proxy fetches + normalizes server-side.
 *
 * Physics honesty: the served `value` is NEST's `corr_for_efficiency` series
 * (upstream efficiency-corrected counts; NMDB serves it pre-normalized as a
 * small deviation-scale series — OBSERVED 2026-09-27). `deviation` is the
 * latest-minus-median in native series units and `deviationMAD` the robust
 * standardized deviation vs the median absolute deviation (percent-of-median
 * was tried first and produced a spurious -2934% on live data because the
 * window median sits near zero — replaced 2026-09-27).
 * DERIVED by us: (latest − median)/median over the requested window. It is
 * a model of cosmic-ray intensity change, not an absolute flux.
 *
 * Consumer contract (worker W7 — cosmic-ray weather UX):
 *   GET /api/nmdb?days=1&stations=OULU,KERG  → JSON
 *   {
 *     fetchedAt, period: { days, start, end }, ttlMs, stale,
 *     stations: [{
 *       code, name, lat, lon,
 *       latest: { t, value } | null,
 *       median, deviation, deviationMAD, samples, status: 'ok'|'nodata'|'error'
 *     }],
 *     unavailable, reason
 *   }
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, no node: imports, no WASM).
 */

const NEST_BASE = 'https://www.nmdb.eu/nest/draw_graph.php';
const UPSTREAM_TIMEOUT_MS = 30_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'SATWQ Reality OS (public NMDB context; contact: nmdb.eu)';
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_DAYS = 3;

/**
 * Curated NMDB stations. Codes are the NMDB registry codes; coordinates are
 * the published NMDB station coordinates (nmdb.eu station table).
 */
const STATIONS = [
  { code: 'OULU', name: 'Oulu', lat: 65.05, lon: 25.47 },
  { code: 'KERG', name: 'Kerguelen', lat: -49.35, lon: 70.25 },
  { code: 'JUNG', name: 'Jungfraujoch', lat: 46.55, lon: 7.98 },
  { code: 'APTY', name: 'Apatity', lat: 67.57, lon: 33.4 },
  { code: 'KIEL', name: 'Kiel', lat: 54.34, lon: 10.12 },
  { code: 'MOSC', name: 'Moscow', lat: 55.47, lon: 37.32 },
  { code: 'NWRK', name: 'Newark', lat: 39.68, lon: -75.75 },
  { code: 'THUL', name: 'Thule', lat: 76.5, lon: -68.7 },
  { code: 'SOPO', name: 'South Pole', lat: -90.0, lon: 0.0 },
  { code: 'MCMU', name: 'McMurdo', lat: -77.85, lon: 166.72 },
  { code: 'TERA', name: 'Terre Adelie', lat: -66.67, lon: 140.0 },
  { code: 'HRMS', name: 'Hermanus', lat: -34.42, lon: 19.22 },
];

const STATION_BY_CODE = new Map(STATIONS.map((s) => [s.code, s]));

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': status === 200 ? 'public, max-age=300' : 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function fetchTextCapped(fetchImpl, url, maxBytes, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok)
      throw Object.assign(new Error(`nmdb_upstream_${response.status}`), {
        status: 502,
      });
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes)
      throw Object.assign(new Error('nmdb_upstream_too_large'), { status: 502 });
    const text = await response.text();
    if (text.length > maxBytes)
      throw Object.assign(new Error('nmdb_upstream_too_large'), { status: 502 });
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function buildNestUrl(stations, days) {
  const params = new URLSearchParams();
  params.set('formchk', '1');
  for (const code of stations) params.append('stations[]', code);
  params.set('output', 'ascii');
  params.set('tabchoice', 'revori');
  params.set('dtype', 'corr_for_efficiency');
  params.set('date_choice', 'last');
  params.set('lastndays', String(days));
  return `${NEST_BASE}?${params.toString()}`;
}

const HEADER_RE = /^#\s*([A-Z][A-Z .]*?):\s*(.+?)\s*$/;
const DATA_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2});\s*(\S+)\s*$/;

/**
 * Parse NEST ASCII output (possibly multiple station blocks) into
 * [{ code, meta, rows: [{ t, value }] }].
 * Pure function — unit-tested with captured fixtures.
 */
export function parseNestAscii(text) {
  const blocks = [];
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const stationMatch = line.match(/^#\s*STATION:\s*(\S+)/);
    if (stationMatch) {
      current = {
        code: stationMatch[1].toUpperCase(),
        meta: {},
        rows: [],
      };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('#')) {
      const headerMatch = line.match(HEADER_RE);
      if (headerMatch) current.meta[headerMatch[1].trim()] = headerMatch[2].trim();
      continue;
    }
    const dataMatch = line.match(DATA_RE);
    if (dataMatch) {
      const value = Number(dataMatch[2]);
      if (Number.isFinite(value))
        current.rows.push({ t: dataMatch[1], value });
    }
  }
  return blocks;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Normalize one station block into the consumer-contract row.
 *
 * The NEST corr_for_efficiency series is itself a deviation-scale series
 * (OBSERVED 2026-09-27: per-minute values like -1.335 with a window median
 * near zero), so percent-of-median is an unstable normalization for it
 * (a median of -0.044 produced a spurious -2934% on live data). Instead we
 * report the deviation in native series units plus a robust standardized
 * deviation vs the median absolute deviation (MAD). Both are DERIVED and
 * must be labeled as such — they are not absolute cosmic-ray flux. */
export function normalizeStationBlock(block) {
  const info = STATION_BY_CODE.get(block.code) || {
    code: block.code,
    name: block.code,
    lat: null,
    lon: null,
  };
  if (!block.rows.length) {
    return {
      code: info.code,
      name: info.name,
      lat: info.lat,
      lon: info.lon,
      latest: null,
      median: null,
      deviation: null,
      deviationMAD: null,
      samples: 0,
      status: 'nodata',
    };
  }
  const values = block.rows.map((r) => r.value);
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  const latest = block.rows[block.rows.length - 1];
  const deviation = latest.value - med;
  const deviationMAD = mad !== null && mad > 1e-12 ? deviation / mad : null;
  const round2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
  return {
    code: info.code,
    name: info.name,
    lat: info.lat,
    lon: info.lon,
    latest: { t: `${latest.t}Z`, value: latest.value },
    median: round2(med),
    deviation: round2(deviation),
    deviationMAD: round2(deviationMAD),
    samples: block.rows.length,
    status: 'ok',
  };
}

export function nmdbProxy({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  let cache = null; // { key, at, payload }

  async function getSnapshot(days, stationCodes) {
    const key = `${days}|${stationCodes.join(',')}`;
    const now = Date.now();
    if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS)
      return { ...cache.payload, stale: false };
    try {
      const text = await fetchTextCapped(
        fetchImpl,
        buildNestUrl(stationCodes, days),
        BODY_CAP_BYTES,
        UPSTREAM_TIMEOUT_MS,
      );
      const blocks = parseNestAscii(text);
      const seen = new Set();
      const stations = stationCodes.map((code) => {
        seen.add(code);
        const block = blocks.find((b) => b.code === code);
        return block
          ? normalizeStationBlock(block)
          : {
              code,
              name: (STATION_BY_CODE.get(code) || {}).name || code,
              lat: (STATION_BY_CODE.get(code) || {}).lat ?? null,
              lon: (STATION_BY_CODE.get(code) || {}).lon ?? null,
              latest: null,
              median: null,
              deviation: null,
              deviationMAD: null,
              samples: 0,
              status: 'nodata',
            };
      });
      // Include any extra blocks the upstream returned (defensive) — but
      // only for allowlisted station codes, so a mangled header line
      // (OBSERVED: "# STATION: KERG," on a truncated page) can never leak
      // a phantom station into the response.
      for (const block of blocks) {
        if (!seen.has(block.code) && STATION_BY_CODE.has(block.code))
          stations.push(normalizeStationBlock(block));
      }
      const payload = {
        fetchedAt: now,
        period: { days, start: null, end: null },
        ttlMs: CACHE_TTL_MS,
        stale: false,
        stations,
        unavailable: false,
        reason: null,
      };
      cache = { key, at: now, payload };
      return payload;
    } catch (error) {
      if (cache && cache.key === key)
        return { ...cache.payload, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
    let days = 1;
    let stationCodes = STATIONS.map((s) => s.code);
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const rawDays = parsed.searchParams.get('days');
      if (rawDays !== null) {
        const d = Number(rawDays);
        if (Number.isFinite(d)) days = Math.min(MAX_DAYS, Math.max(1, Math.floor(d)));
      }
      const s = parsed.searchParams.get('stations');
      if (s) {
        const wanted = s
          .split(',')
          .map((c) => c.trim().toUpperCase())
          .filter((c) => STATION_BY_CODE.has(c));
        if (wanted.length) stationCodes = [...new Set(wanted)];
      }
    } catch {
      return sendJson(res, 400, { error: 'nmdb_bad_request' });
    }
    try {
      sendJson(res, 200, await getSnapshot(days, stationCodes));
    } catch (error) {
      sendJson(res, error.status === 502 ? 502 : 500, {
        error: 'nmdb_upstream_unavailable',
      });
    }
  }

  return {
    name: 'nmdb',
    configureServer({ middlewares }) {
      middlewares.use('/api/nmdb', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/nmdb', handler);
    },
  };
}
