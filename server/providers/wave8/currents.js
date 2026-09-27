/**
 * Wave 8 — NDBC HF-radar surface currents (catalog Wave D item 67, #88).
 *
 * WHY A SNAPSHOT PIPELINE: NDBC serves hourly gridded HF-radar total-vector
 * fields as NetCDF-4 via THREDDS
 * (https://dods.ndbc.noaa.gov/thredds/catalog/hfradar/catalog.html — an
 * 18 MB HTML catalog over hourly NetCDFs). NetCDF-4 is HDF5-based: no pure-JS
 * edge decode exists, and the full grids (e.g. 460x701 for USEGC 6 km) are
 * far too heavy to pull through the edge on every cache miss.
 * `scripts/hfradar-snapshot.mjs` (the only place the upstream is touched —
 * it runs in GitHub Actions) reads the machine-readable catalog.xml, picks
 * the newest file per configured region, and pulls a STRIDED SUBSET through
 * the THREDDS OPeNDAP `.ascii` service — plain text, no NetCDF library
 * needed — then scales, filters fill values, validates, and publishes
 * `hfradar-latest.json` to the `hfradar-latest` GitHub release on
 * Sheldondouthat/satwq-reality-os. THIS provider only ever fetches that
 * compact pre-computed snapshot.
 *
 * Routes:
 *   GET /api/currents → { generatedAt, stale, snapshot:{…}, regions:[…], attribution }
 *
 * Keyless, NOAA public domain (attribute NDBC/IOOS), Pages-safe (global
 * fetch only, capped reads, redirect:'follow' — workerd supports only
 * 'follow'/'manual'; 'error' throws at the edge (main 2ec4053), no node:
 * imports, no WASM).
 *
 * Probe notes (2026-09-27, build VM): catalog.xml is ~9.4 MB with
 * urlPath="hfradar/rtv-<region>-<res>-uwls_v1r0_hfr_s<start>_e<end>_c<created>.nc";
 * newest USEGC-6km file 2026-09-27T20:00Z (current). .dds shows
 * u/v as Int16[time=1][lat][lon] with scale_factor 0.01, _FillValue -32767,
 * units "m s-1"; lat/lon are 1-D Float32 axes. A strided .ascii request
 * (u[0:1:0][0:20:459][0:20:700],…) returned valid text. The snapshot release
 * did not exist before this build — scripts/hfradar-snapshot.mjs publishes it.
 */

import { readResponseTextCapped } from '../common/http.js';

const SNAPSHOT_URL =
  'https://github.com/Sheldondouthat/satwq-reality-os/releases/download/hfradar-latest/hfradar-latest.json';
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 512 * 1024; // snapshots are <150 KB; 512 KB is generous headroom
const CACHE_TTL_MS = 1 * 3600_000; // HF-radar files are hourly
const STALE_MS = 6 * 3600_000;
const RETRY_COOLDOWN_MS = 60_000;
const USER_AGENT = 'Gods Eye View (HF-radar currents layer)';
const SNAPSHOT_FORMAT = 'hfradar-snapshot';
export const MIN_REGION_POINTS = 10; // sanity floor — a real strided region holds hundreds
const MAX_SPEED_MS = 15; // physical sanity: HF-radar surface speeds are ~cm/s–m/s

let cache = null; // {at, payload}
let inflight = null;
let attemptedAt = -Infinity;

/**
 * Parse a THREDDS OPeNDAP `.ascii` response for one HF-radar total-vector
 * file into raw (unscaled Int16) grids. Throws currents_ascii_invalid with
 * status 502 when the shape is not what the NDBC server returns.
 *
 * Expected sections (blank-line separated):
 *   time[1]            → single epoch-seconds integer
 *   lat[N]             → N comma-separated floats
 *   lon[M]             → M comma-separated floats
 *   u.u[1][N][M]       → N rows, each "[0][r], v,v,…" (rows may wrap lines)
 *   v.v[1][N][M]       → same for v
 */
export function parseHfradarAscii(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw Object.assign(new Error('currents_ascii_invalid: empty response'), {
      status: 502,
    });
  }
  const lines = text.split('\n');
  let timeEpoch = null;
  let lat = null;
  let lon = null;
  let u = null;
  let v = null;

  const parseFloatList = (line, what) => {
    const values = line
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map(Number);
    if (values.length === 0 || !values.every(Number.isFinite)) {
      throw Object.assign(
        new Error(`currents_ascii_invalid: bad ${what} values`),
        {
          status: 502,
        },
      );
    }
    return values;
  };

  const readGridArray = (startIdx, rows, cols, what) => {
    // Accumulate comma-separated numbers across lines until rows*cols are
    // read; each data line may carry a "[d][r]," row prefix.
    const values = [];
    let idx = startIdx;
    while (values.length < rows * cols && idx < lines.length) {
      const line = lines[idx].replace(/^\s*\[\d+\]\[\d+\],?\s*/, '').trim();
      idx++;
      if (line === '') continue;
      for (const part of line.split(',')) {
        const token = part.trim();
        if (token === '') continue;
        const num = Number(token);
        if (!Number.isFinite(num)) {
          throw Object.assign(
            new Error(`currents_ascii_invalid: bad ${what} value`),
            {
              status: 502,
            },
          );
        }
        values.push(num);
        if (values.length >= rows * cols) break;
      }
    }
    if (values.length !== rows * cols) {
      throw Object.assign(
        new Error(
          `currents_ascii_invalid: ${what} has ${values.length} values, expected ${rows * cols}`,
        ),
        { status: 502 },
      );
    }
    const grid = [];
    for (let r = 0; r < rows; r++)
      grid.push(values.slice(r * cols, (r + 1) * cols));
    return { grid, nextIdx: idx };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let m;
    if (/^time\[\d+\]$/.test(line)) {
      const vals = parseFloatList((lines[i + 1] ?? '').trim(), 'time');
      timeEpoch = vals[0];
      i++;
    } else if ((m = line.match(/^lat\[(\d+)\]$/))) {
      lat = parseFloatList((lines[i + 1] ?? '').trim(), 'lat');
      if (lat.length !== Number(m[1])) {
        throw Object.assign(
          new Error(
            `currents_ascii_invalid: lat has ${lat.length} values, expected ${m[1]}`,
          ),
          { status: 502 },
        );
      }
      i++;
    } else if ((m = line.match(/^lon\[(\d+)\]$/))) {
      lon = parseFloatList((lines[i + 1] ?? '').trim(), 'lon');
      if (lon.length !== Number(m[1])) {
        throw Object.assign(
          new Error(
            `currents_ascii_invalid: lon has ${lon.length} values, expected ${m[1]}`,
          ),
          { status: 502 },
        );
      }
      i++;
    } else if ((m = line.match(/^[uv]\.[uv]\[1\]\[(\d+)\]\[(\d+)\]$/))) {
      const rows = Number(m[1]);
      const cols = Number(m[2]);
      const { grid, nextIdx } = readGridArray(i + 1, rows, cols, line);
      if (line.startsWith('u.')) u = grid;
      else v = grid;
      i = nextIdx - 1;
    }
  }

  const problems = [];
  if (!Number.isFinite(timeEpoch)) problems.push('missing time');
  if (!lat || lat.length === 0) problems.push('missing lat');
  if (!lon || lon.length === 0) problems.push('missing lon');
  if (!u) problems.push('missing u');
  if (!v) problems.push('missing v');
  if (u && (u.length !== lat?.length || u[0]?.length !== lon?.length)) {
    problems.push('u grid dims mismatch lat/lon');
  }
  if (v && (v.length !== lat?.length || v[0]?.length !== lon?.length)) {
    problems.push('v grid dims mismatch lat/lon');
  }
  if (problems.length) {
    throw Object.assign(
      new Error(`currents_ascii_invalid: ${problems.join('; ')}`),
      {
        status: 502,
      },
    );
  }
  return {
    timeEpoch,
    time: new Date(timeEpoch * 1000).toISOString(),
    lat,
    lon,
    u,
    v,
  };
}

/**
 * Assemble the publishable snapshot document from per-region parsed grids.
 * Pure + deterministic; shared by scripts/hfradar-snapshot.mjs and the tests.
 *
 * Each region entry carries flat valid-point arrays (fill values already
 * dropped by the caller): { region, upstreamFile, upstreamUrl, time, lon,
 * lat, u, v } with u/v in m/s.
 */
export function buildCurrentsSnapshot({ fetchedAt, regions }) {
  if (!Array.isArray(regions) || regions.length === 0) {
    throw Object.assign(new Error('currents_snapshot_invalid: no regions'), {
      status: 502,
    });
  }
  const built = regions.map((r, idx) => {
    const prefix = `region ${idx}${r?.region ? ` (${r.region})` : ''}`;
    for (const key of ['lon', 'lat', 'u', 'v']) {
      if (!Array.isArray(r?.[key])) {
        throw Object.assign(
          new Error(`currents_snapshot_invalid: ${prefix} missing ${key}`),
          {
            status: 502,
          },
        );
      }
    }
    const n = r.lon.length;
    if (n < MIN_REGION_POINTS) {
      throw Object.assign(
        new Error(
          `currents_snapshot_invalid: ${prefix} only ${n} points (min ${MIN_REGION_POINTS})`,
        ),
        { status: 502 },
      );
    }
    if (![r.lat, r.u, r.v].every((a) => a.length === n)) {
      throw Object.assign(
        new Error(
          `currents_snapshot_invalid: ${prefix} arrays differ in length`,
        ),
        { status: 502 },
      );
    }
    if (typeof r.time !== 'string' || !Number.isFinite(Date.parse(r.time))) {
      throw Object.assign(
        new Error(`currents_snapshot_invalid: ${prefix} bad time`),
        {
          status: 502,
        },
      );
    }
    let speedMax = 0;
    let speedSum = 0;
    for (let i = 0; i < n; i++) {
      const { lon, lat, u, v } = {
        lon: r.lon[i],
        lat: r.lat[i],
        u: r.u[i],
        v: r.v[i],
      };
      if (![lon, lat, u, v].every(Number.isFinite)) {
        throw Object.assign(
          new Error(
            `currents_snapshot_invalid: ${prefix} non-finite value at ${i}`,
          ),
          { status: 502 },
        );
      }
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        throw Object.assign(
          new Error(
            `currents_snapshot_invalid: ${prefix} coordinate out of range at ${i}`,
          ),
          { status: 502 },
        );
      }
      const speed = Math.hypot(u, v);
      if (speed > MAX_SPEED_MS) {
        throw Object.assign(
          new Error(
            `currents_snapshot_invalid: ${prefix} implausible speed ${speed.toFixed(2)} m/s at ${i}`,
          ),
          { status: 502 },
        );
      }
      if (speed > speedMax) speedMax = speed;
      speedSum += speed;
    }
    return {
      region: r.region,
      upstreamFile: r.upstreamFile,
      upstreamUrl: r.upstreamUrl,
      time: r.time,
      pointCount: n,
      stats: {
        speedMax: Math.round(speedMax * 1000) / 1000,
        speedMean: Math.round((speedSum / n) * 1000) / 1000,
      },
      lon: r.lon,
      lat: r.lat,
      u: r.u,
      v: r.v,
    };
  });
  const snap = {
    format: SNAPSHOT_FORMAT,
    formatVersion: 1,
    fetchedAt,
    regions: built,
  };
  validateCurrentsSnapshot(snap);
  return snap;
}

/**
 * Validate a snapshot document (published asset or test fixture).
 * Throws currents_snapshot_invalid with status 502 — the asset is upstream
 * data, so a corrupt one is an upstream failure, not a code bug.
 */
export function validateCurrentsSnapshot(snap) {
  const problems = [];
  if (snap?.format !== SNAPSHOT_FORMAT) problems.push('bad format marker');
  if (snap?.formatVersion !== 1) problems.push('unsupported formatVersion');
  if (
    typeof snap?.fetchedAt !== 'string' ||
    !Number.isFinite(Date.parse(snap.fetchedAt))
  ) {
    problems.push('bad fetchedAt');
  }
  const regions = snap?.regions;
  if (!Array.isArray(regions) || regions.length === 0) {
    problems.push('no regions');
  } else {
    regions.forEach((r, idx) => {
      if (typeof r?.region !== 'string' || !r.region)
        problems.push(`region ${idx}: bad name`);
      if (typeof r?.time !== 'string' || !Number.isFinite(Date.parse(r.time))) {
        problems.push(`region ${idx}: bad time`);
      }
      const arrays = [r?.lon, r?.lat, r?.u, r?.v];
      if (!arrays.every(Array.isArray)) {
        problems.push(`region ${idx}: arrays missing`);
      } else {
        const n = arrays[0].length;
        if (!arrays.every((a) => a.length === n))
          problems.push(`region ${idx}: arrays differ`);
        if (n < MIN_REGION_POINTS)
          problems.push(`region ${idx}: only ${n} points`);
        if (!arrays.every((a) => a.every(Number.isFinite))) {
          problems.push(`region ${idx}: non-finite values`);
        }
      }
      if (
        !Number.isInteger(r?.pointCount) ||
        r.pointCount < MIN_REGION_POINTS
      ) {
        problems.push(`region ${idx}: bad pointCount`);
      } else if (
        arrays.every(Array.isArray) &&
        r.pointCount !== arrays[0].length
      ) {
        problems.push(
          `region ${idx}: pointCount ${r.pointCount} != array length ${arrays[0].length}`,
        );
      }
      // Recompute the stats from the arrays themselves; never trust supplied
      // stats in a document that could have been hand-edited.
      if (arrays.every(Array.isArray)) {
        const n = arrays[0].length;
        let max = 0;
        let sum = 0;
        let bad = false;
        for (let i = 0; i < n; i++) {
          const lon = arrays[0][i];
          const lat = arrays[1][i];
          const u = arrays[2][i];
          const v = arrays[3][i];
          if (lon < -180 || lon > 180 || lat < -90 || lat > 90) bad = true;
          const speed = Math.hypot(u, v);
          if (speed > MAX_SPEED_MS) bad = true;
          if (speed > max) max = speed;
          sum += speed;
        }
        if (bad) {
          problems.push(
            `region ${idx}: coordinate out of range or implausible speed`,
          );
        } else {
          const stats = r?.stats;
          const mean = n ? sum / n : 0;
          if (
            Math.abs((stats?.speedMax ?? NaN) - Math.round(max * 1000) / 1000) >
              0.002 ||
            Math.abs(
              (stats?.speedMean ?? NaN) - Math.round(mean * 1000) / 1000,
            ) > 0.002
          ) {
            problems.push(`region ${idx}: stats do not match arrays`);
          }
        }
      }
      const basicStats = r?.stats;
      if (
        !basicStats ||
        !Number.isFinite(basicStats.speedMax) ||
        !Number.isFinite(basicStats.speedMean) ||
        basicStats.speedMax < 0 ||
        basicStats.speedMean < 0 ||
        basicStats.speedMax > MAX_SPEED_MS
      ) {
        problems.push(`region ${idx}: bad stats`);
      }
    });
  }
  if (problems.length) {
    throw Object.assign(
      new Error(`currents_snapshot_invalid: ${problems.join('; ')}`),
      {
        status: 502,
      },
    );
  }
  return true;
}

async function fetchSnapshot(fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(SNAPSHOT_URL, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). GitHub release assets
      // redirect to the CDN, so follow is required here.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok)
      throw Object.assign(new Error(`currents_snapshot_http_${res.status}`), {
        status: 502,
      });
    const text = await readResponseTextCapped(res, BODY_CAP_BYTES); // throws when too large
    const snap = JSON.parse(text);
    validateCurrentsSnapshot(snap); // throws {status:502} on a corrupt asset — an upstream failure
    return snap;
  } finally {
    clearTimeout(timer);
  }
}

function buildPayload(snap, nowMs, stale) {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    stale,
    snapshot: {
      format: snap.format,
      formatVersion: snap.formatVersion,
      fetchedAt: snap.fetchedAt,
    },
    regions: snap.regions,
    attribution:
      'Surface currents: NDBC/IOOS HF-radar total vectors via OPeNDAP (NOAA). ' +
      'Snapshot: strided subset by scripts/hfradar-snapshot.mjs.',
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
      throw new Error('currents_retry_later');
    attemptedAt = nowMs;
    inflight = fetchSnapshot(fetchImpl)
      .then((snap) => {
        cache = { at: nowMs, payload: snap };
        return buildPayload(snap, nowMs, false);
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

function sendJson(res, status, body, cacheControl = 'public, max-age=3600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

export function currentsProxy({
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
          {
            error: 'currents_unavailable',
            detail: error?.message ?? 'unknown',
          },
          'no-store',
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'currents',
    configureServer({ middlewares }) {
      middlewares.use('/api/currents', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/currents', handler);
    },
  };
}

export const _currentsInternals = {
  SNAPSHOT_URL,
  parseHfradarAscii,
  buildCurrentsSnapshot,
  validateCurrentsSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
    attemptedAt = -Infinity;
  },
};
