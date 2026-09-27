/**
 * Wave 8 — DWD ICON-D2 2 m temperature layer (catalog Wave D item 65, #114).
 *
 * WHY A SNAPSHOT PIPELINE: ICON-D2 NWP output is GRIB2 binary
 * (https://opendata.dwd.de/weather/nwp/icon-d2/grib/, 3-hourly runs) and the
 * edge cannot parse GRIB — the regular-lat-lon t_2m file is 1.6 MB for
 * 1215x746 points. `scripts/icon-d2-snapshot.mjs` (the only place a GRIB file
 * is ever downloaded — it runs in GitHub Actions with node:, bzip2 and the
 * eccodes-wasm GRIB decoder) picks the newest complete model run, decodes
 * the requested forecast horizons, bins them to a coarse regular grid,
 * validates the result, and publishes `icon-d2-latest.json` to the
 * `icon-d2-latest` GitHub release on Sheldondouthat/satwq-reality-os. THIS
 * provider only ever fetches that compact pre-computed snapshot — it never
 * touches a GRIB file.
 *
 * Routes:
 *   GET /api/icon-d2 → { generatedAt, stale, snapshot:{…}, horizons:[…], attribution }
 *
 * Keyless, DWD open data, Pages-safe (global fetch only, capped reads,
 * redirect:'follow' — workerd supports only 'follow'/'manual'; 'error'
 * throws at the edge (main 2ec4053), no node: imports, no WASM).
 *
 * Probe notes (2026-09-27, build VM): newest run dir "21" held run
 * 2026092621 (run dirs lag the wall clock — the script picks the newest
 * run that actually contains every requested horizon). t_2m
 * regular-lat-lon file decodes via decodeWindGribMessage: 1215x746,
 * 0.02 deg, lon 356.06→20.34 (i.e. -3.94→20.34E), lat 43.18→58.08
 * (jScansPositively=1), units K, shortName "2t", DWD missing marker 9999.
 * The icosahedral variant cannot expose lat/lon through the wasm build, so
 * the pipeline uses regular-lat-lon. The snapshot release did not exist
 * before this build — scripts/icon-d2-snapshot.mjs publishes it.
 */

import { readResponseTextCapped } from '../common/http.js';

const SNAPSHOT_URL =
  'https://github.com/Sheldondouthat/satwq-reality-os/releases/download/icon-d2-latest/icon-d2-latest.json';
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 512 * 1024; // snapshots are <200 KB; 512 KB is generous headroom
const CACHE_TTL_MS = 3 * 3600_000; // ICON-D2 runs every 3 h
const STALE_MS = 12 * 3600_000;
const RETRY_COOLDOWN_MS = 60_000;
const USER_AGENT = 'Gods Eye View (ICON-D2 temperature layer)';
const SNAPSHOT_FORMAT = 'icon-d2-snapshot';
const MISSING_THRESHOLD_K = 9000; // DWD GRIB missing marker is 9999
const MIN_VALID_CELLS = 10; // sanity floor — a real horizon holds thousands
// Generous physical bounds for 2 m temperature in Kelvin; a file that
// violates them is corrupt, not a heatwave.
const T2M_MIN_K = 150;
const T2M_MAX_K = 350;

let cache = null; // {at, payload}
let inflight = null;
let attemptedAt = -Infinity;

function normalizeLon(lon) {
  return lon > 180 ? lon - 360 : lon;
}

function roundTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Bin a decoded regular lat/lon temperature grid to a coarse regular grid.
 * Pure; shared by scripts/icon-d2-snapshot.mjs and the tests. Orientation is
 * derived from the grid geometry (lat may increase or decrease with j), so a
 * scan-direction change upstream does not silently corrupt the snapshot.
 * DWD missing values (>= 9000, marker 9999) are excluded from cell means;
 * cells with no valid points become null.
 */
export function binTemperatureGrid(
  { ni, nj, lo1, la1, di, dj, values },
  binDeg,
) {
  if (
    !Number.isInteger(ni) ||
    !Number.isInteger(nj) ||
    ni < 1 ||
    nj < 1 ||
    !Number.isFinite(lo1) ||
    !Number.isFinite(la1) ||
    !Number.isFinite(di) ||
    !Number.isFinite(dj) ||
    di <= 0 ||
    dj === 0 ||
    !Number.isFinite(binDeg) ||
    binDeg <= 0
  ) {
    throw Object.assign(new Error('icon_d2_grid_invalid: bad grid geometry'), {
      status: 502,
    });
  }
  const n = ni * nj;
  if (!values || values.length < n) {
    throw Object.assign(
      new Error('icon_d2_grid_invalid: values shorter than ni*nj'),
      {
        status: 502,
      },
    );
  }
  const lonMin = normalizeLon(lo1);
  const lonMax = lonMin + (ni - 1) * di;
  const latA = la1;
  const latB = la1 + (nj - 1) * dj;
  const latMin = Math.min(latA, latB);
  const latMax = Math.max(latA, latB);
  const nx = Math.max(1, Math.floor((lonMax - lonMin) / binDeg) + 1);
  const ny = Math.max(1, Math.floor((latMax - latMin) / binDeg) + 1);
  const sums = new Float64Array(nx * ny);
  const counts = new Uint32Array(nx * ny);
  for (let j = 0; j < nj; j++) {
    const lat = la1 + j * dj;
    const bj = Math.min(ny - 1, Math.floor((lat - latMin) / binDeg));
    for (let i = 0; i < ni; i++) {
      const v = values[j * ni + i];
      if (!Number.isFinite(v) || v >= MISSING_THRESHOLD_K) continue;
      const lon = lonMin + i * di;
      const bi = Math.min(nx - 1, Math.floor((lon - lonMin) / binDeg));
      const k = bj * nx + bi;
      sums[k] += v;
      counts[k] += 1;
    }
  }
  const grid = new Array(nx * ny);
  let validCells = 0;
  let missingCells = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let k = 0; k < nx * ny; k++) {
    if (counts[k] === 0) {
      grid[k] = null;
      missingCells++;
      continue;
    }
    const mean = sums[k] / counts[k];
    grid[k] = roundTo(mean, 2);
    validCells++;
    sum += mean;
    if (mean < min) min = mean;
    if (mean > max) max = mean;
  }
  if (validCells < MIN_VALID_CELLS) {
    throw Object.assign(
      new Error(
        `icon_d2_grid_invalid: only ${validCells} valid cells (min ${MIN_VALID_CELLS})`,
      ),
      { status: 502 },
    );
  }
  return {
    nx,
    ny,
    lon0: roundTo(lonMin, 4),
    lat0: roundTo(latMin, 4),
    dLon: binDeg,
    dLat: binDeg,
    values: grid,
    pointCount: validCells,
    missingCount: missingCells,
    stats: {
      min: roundTo(min, 2),
      max: roundTo(max, 2),
      mean: roundTo(sum / validCells, 2),
    },
  };
}

/**
 * Assemble the publishable snapshot document from binned horizon grids.
 * Pure + deterministic; shared by scripts/icon-d2-snapshot.mjs and the tests.
 */
export function buildIconD2Snapshot({
  run,
  fetchedAt,
  param = 't_2m',
  units = 'K',
  horizons,
}) {
  if (!Array.isArray(horizons) || horizons.length === 0) {
    throw Object.assign(new Error('icon_d2_snapshot_invalid: no horizons'), {
      status: 502,
    });
  }
  const built = horizons.map((h, idx) => {
    if (!Number.isFinite(h?.forecastHour) || h.forecastHour < 0) {
      throw Object.assign(
        new Error(`icon_d2_snapshot_invalid: horizon ${idx} bad forecastHour`),
        { status: 502 },
      );
    }
    if (
      typeof h?.validTime !== 'string' ||
      !Number.isFinite(Date.parse(h.validTime))
    ) {
      throw Object.assign(
        new Error(`icon_d2_snapshot_invalid: horizon ${idx} bad validTime`),
        { status: 502 },
      );
    }
    const grid = h.grid;
    if (!grid || grid.pointCount < MIN_VALID_CELLS) {
      throw Object.assign(
        new Error(
          `icon_d2_snapshot_invalid: horizon ${idx} has no usable grid`,
        ),
        { status: 502 },
      );
    }
    return {
      forecastHour: h.forecastHour,
      validTime: h.validTime,
      pointCount: grid.pointCount,
      missingCount: grid.missingCount,
      stats: grid.stats,
      values: grid.values,
    };
  });
  const first = horizons[0].grid;
  const snap = {
    format: SNAPSHOT_FORMAT,
    formatVersion: 1,
    run,
    fetchedAt,
    param,
    units,
    grid: {
      nx: first.nx,
      ny: first.ny,
      lon0: first.lon0,
      lat0: first.lat0,
      dLon: first.dLon,
      dLat: first.dLat,
    },
    horizons: built,
  };
  validateIconD2Snapshot(snap);
  return snap;
}

/**
 * Validate a snapshot document (published asset or test fixture).
 * Throws icon_d2_snapshot_invalid with status 502 — the asset is upstream
 * data, so a corrupt one is an upstream failure, not a code bug.
 */
export function validateIconD2Snapshot(snap) {
  const problems = [];
  if (snap?.format !== SNAPSHOT_FORMAT) problems.push('bad format marker');
  if (snap?.formatVersion !== 1) problems.push('unsupported formatVersion');
  if (typeof snap?.run !== 'string' || !Number.isFinite(Date.parse(snap.run))) {
    problems.push('bad run timestamp');
  }
  if (
    typeof snap?.fetchedAt !== 'string' ||
    !Number.isFinite(Date.parse(snap.fetchedAt))
  ) {
    problems.push('bad fetchedAt');
  }
  const grid = snap?.grid;
  if (
    !grid ||
    !Number.isInteger(grid.nx) ||
    !Number.isInteger(grid.ny) ||
    grid.nx < 1 ||
    grid.ny < 1 ||
    grid.nx > 2000 ||
    grid.ny > 2000
  ) {
    problems.push('bad grid geometry');
  }
  const horizons = snap?.horizons;
  if (!Array.isArray(horizons) || horizons.length === 0) {
    problems.push('no horizons');
  } else {
    const expectLen = grid?.nx * grid?.ny;
    horizons.forEach((h, idx) => {
      if (!Number.isFinite(h?.forecastHour) || h.forecastHour < 0) {
        problems.push(`horizon ${idx}: bad forecastHour`);
      }
      if (
        typeof h?.validTime !== 'string' ||
        !Number.isFinite(Date.parse(h.validTime))
      ) {
        problems.push(`horizon ${idx}: bad validTime`);
      }
      if (!Array.isArray(h?.values) || h.values.length !== expectLen) {
        problems.push(
          `horizon ${idx}: values length ${h?.values?.length} != ${expectLen}`,
        );
      } else if (!h.values.every((v) => v === null || Number.isFinite(v))) {
        problems.push(`horizon ${idx}: non-finite values`);
      }
      const stats = h?.stats;
      if (
        !stats ||
        !Number.isFinite(stats.min) ||
        !Number.isFinite(stats.max) ||
        !Number.isFinite(stats.mean) ||
        stats.min > stats.mean ||
        stats.mean > stats.max
      ) {
        problems.push(`horizon ${idx}: bad stats`);
      } else if (stats.min < T2M_MIN_K || stats.max > T2M_MAX_K) {
        problems.push(`horizon ${idx}: stats outside physical bounds`);
      }
      if (!Number.isInteger(h?.pointCount) || h.pointCount < MIN_VALID_CELLS) {
        problems.push(`horizon ${idx}: too few valid cells`);
      }
    });
  }
  if (problems.length) {
    throw Object.assign(
      new Error(`icon_d2_snapshot_invalid: ${problems.join('; ')}`),
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
      throw Object.assign(new Error(`icon_d2_snapshot_http_${res.status}`), {
        status: 502,
      });
    const text = await readResponseTextCapped(res, BODY_CAP_BYTES); // throws when too large
    const snap = JSON.parse(text);
    validateIconD2Snapshot(snap); // throws {status:502} on a corrupt asset — an upstream failure
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
      run: snap.run,
      fetchedAt: snap.fetchedAt,
      param: snap.param,
      units: snap.units,
      grid: snap.grid,
    },
    horizons: snap.horizons,
    attribution:
      '2 m temperature: DWD ICON-D2 NWP (Deutscher Wetterdienst open data). ' +
      'Snapshot: binned from GRIB2 to a coarse grid by scripts/icon-d2-snapshot.mjs.',
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
      throw new Error('icon_d2_retry_later');
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

function sendJson(res, status, body, cacheControl = 'public, max-age=10800') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

export function iconD2Proxy({
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
          { error: 'icon_d2_unavailable', detail: error?.message ?? 'unknown' },
          'no-store',
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'icon-d2',
    configureServer({ middlewares }) {
      middlewares.use('/api/icon-d2', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/icon-d2', handler);
    },
  };
}

export const _iconD2Internals = {
  SNAPSHOT_URL,
  binTemperatureGrid,
  buildIconD2Snapshot,
  validateIconD2Snapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
    attemptedAt = -Infinity;
  },
};
