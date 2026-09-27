/**
 * Wave 7 — NOAA GloTEC ionosphere layer (catalog Wave C item 57, #47).
 *
 * WHY A SNAPSHOT PIPELINE: the live GloTEC GeoJSON is a 2.4 MB
 * FeatureCollection (5184 points, refreshed ~every 10 min) at
 * https://services.swpc.noaa.gov/products/glotec/geojson_2d_urt/ — too heavy
 * to pull through the edge on every cache miss. `scripts/tec-snapshot.mjs`
 * (the only place the 2.4 MB file is ever downloaded) picks the newest
 * `glotec_icao_*.geojson`, downsamples it to a 36x36 grid, validates it, and
 * publishes `tec-latest.json` to the `tec-latest` GitHub release on
 * Sheldondouthat/satwq-reality-os. THIS provider only ever fetches that
 * compact pre-computed snapshot — it never touches the raw 2.4 MB file.
 *
 * Routes:
 *   GET /api/tec → { generatedAt, stale, snapshot:{…}, stats:{…}, grid:{…}, attribution }
 *
 * Keyless, NOAA public domain, Pages-safe (global fetch only, capped reads,
 * redirect:'follow' — workerd supports only 'follow'/'manual'; 'error'
 * throws at the edge (main 2ec4053), no node: imports, no WASM).
 *
 * Probe notes (2026-09-27, build VM): SWPC dir listing → 200, files named
 * glotec_icao_YYYYMMDDTHHMMSSZ.geojson, 2.4 MB each, ~10 min cadence, newest
 * observed 20260927T205500Z; a full file parsed cleanly (5184 pts, props
 * tec/anomaly/hmF2/NmF2/quality_flag, lon-major 72x72 grid). The snapshot
 * release did not exist before this build — scripts/tec-snapshot.mjs
 * publishes it.
 */

import { readResponseTextCapped } from "../common/http.js";

const SNAPSHOT_URL =
  "https://github.com/Sheldondouthat/satwq-reality-os/releases/download/tec-latest/tec-latest.json";
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 512 * 1024; // snapshots are ~65 KB; 512 KB is generous headroom
const CACHE_TTL_MS = 10 * 60_000; // GloTEC refreshes ~every 10 min
const STALE_MS = 6 * 3600_000;
const RETRY_COOLDOWN_MS = 60_000;
const USER_AGENT = "Gods Eye View (GloTEC ionosphere layer)";
const SNAPSHOT_FORMAT = "glotec-snapshot";
const MIN_SNAPSHOT_POINTS = 100; // sanity floor — a real snapshot holds ~1296

let cache = null; // {at, payload}
let inflight = null;
let attemptedAt = -Infinity;

/**
 * Parse a GloTEC GeoJSON FeatureCollection into a flat point list.
 * Throws tec_geojson_invalid when the shape is not what SWPC publishes.
 */
export function parseGloTecGeoJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("tec_geojson_invalid: not JSON"), { status: 502 });
  }
  if (doc?.type !== "FeatureCollection" || !Array.isArray(doc.features)) {
    throw Object.assign(new Error("tec_geojson_invalid: not a FeatureCollection"), { status: 502 });
  }
  const points = [];
  for (const f of doc.features) {
    const coords = f?.geometry?.coordinates;
    const props = f?.properties;
    const lon = Number(coords?.[0]);
    const lat = Number(coords?.[1]);
    const tec = Number(props?.tec);
    const anomaly = Number(props?.anomaly);
    const hmF2 = Number(props?.hmF2);
    const nmF2 = Number(props?.NmF2);
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(tec) ||
      !Number.isFinite(anomaly) ||
      !Number.isFinite(hmF2) ||
      !Number.isFinite(nmF2)
    ) {
      continue; // skip degenerate points; the count check below keeps us honest
    }
    points.push({
      lon,
      lat,
      tec,
      anomaly,
      hmF2,
      nmF2,
      quality: Number.isFinite(Number(props?.quality_flag)) ? Number(props.quality_flag) : null,
    });
  }
  if (points.length < 1000) {
    throw Object.assign(
      new Error(`tec_geojson_invalid: only ${points.length} valid points (expected ~5184)`),
      { status: 502 },
    );
  }
  return { pointCount: points.length, points };
}

function roundTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Downsample a point cloud to a coarse lat-major grid by striding rows and
 * columns. Row detection is data-driven (groups by latitude), so a grid
 * reshape upstream does not silently corrupt the snapshot.
 */
export function downsampleTec(points, strideLat = 2, strideLon = 2, minPoints = MIN_SNAPSHOT_POINTS) {
  const rows = new Map(); // latKey -> points
  for (const p of points) {
    const key = p.lat.toFixed(9);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(p);
  }
  const rowKeys = [...rows.keys()].map(Number).sort((a, b) => a - b);
  const lon = [];
  const lat = [];
  const tec = [];
  const anomaly = [];
  const hmF2 = [];
  const nmF2 = [];
  rowKeys.forEach((latKey, rowIdx) => {
    if (rowIdx % strideLat !== 0) return;
    const row = rows
      .get(latKey.toFixed(9))
      .slice()
      .sort((a, b) => a.lon - b.lon);
    row.forEach((p, colIdx) => {
      if (colIdx % strideLon !== 0) return;
      lon.push(roundTo(p.lon, 2));
      lat.push(roundTo(p.lat, 2));
      tec.push(roundTo(p.tec, 3));
      anomaly.push(roundTo(p.anomaly, 3));
      hmF2.push(roundTo(p.hmF2, 1));
      nmF2.push(Math.round(p.nmF2));
    });
  });
  if (lon.length < minPoints) {
    throw Object.assign(
      new Error(`tec_downsample_invalid: only ${lon.length} grid points after stride (min ${minPoints})`),
      { status: 502 },
    );
  }
  return {
    strideLat,
    strideLon,
    gridPoints: lon.length,
    grid: { lon, lat, tec, anomaly, hmF2, nmF2 },
  };
}

function medianOf(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Summary statistics over the FULL point set (not the downsampled grid). */
export function computeTecStats(points) {
  const tec = points.map((p) => p.tec);
  const anomaly = points.map((p) => p.anomaly);
  const hmF2 = points.map((p) => p.hmF2);
  const qualityFlags = {};
  for (const p of points) {
    const q = String(p.quality ?? "unknown");
    qualityFlags[q] = (qualityFlags[q] ?? 0) + 1;
  }
  const summarize = (values) => ({
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    median: medianOf(values),
  });
  return {
    count: points.length,
    tec: summarize(tec),
    anomaly: summarize(anomaly),
    hmF2: { mean: hmF2.reduce((a, b) => a + b, 0) / hmF2.length },
    qualityFlags,
  };
}

/**
 * Build the publishable snapshot document from a raw GloTEC GeoJSON string.
 * Pure + deterministic; shared by scripts/tec-snapshot.mjs and the tests.
 */
export function buildTecSnapshot(geoJsonText, { upstreamFile, upstreamUrl, fetchedAt }) {
  const { pointCount, points } = parseGloTecGeoJson(geoJsonText);
  const down = downsampleTec(points);
  const stats = computeTecStats(points);
  return {
    format: SNAPSHOT_FORMAT,
    formatVersion: 1,
    upstreamFile,
    upstreamUrl,
    fetchedAt,
    pointCount,
    strideLat: down.strideLat,
    strideLon: down.strideLon,
    gridPoints: down.gridPoints,
    stats,
    grid: down.grid,
  };
}

/**
 * Validate a snapshot document (published asset or test fixture).
 * Throws tec_snapshot_invalid with status 502 — the asset is upstream data,
 * so a corrupt one is an upstream failure, not a code bug.
 */
export function validateTecSnapshot(snap) {
  const problems = [];
  if (snap?.format !== SNAPSHOT_FORMAT) problems.push("bad format marker");
  if (snap?.formatVersion !== 1) problems.push("unsupported formatVersion");
  if (typeof snap?.upstreamFile !== "string" || !snap.upstreamFile) problems.push("missing upstreamFile");
  if (typeof snap?.fetchedAt !== "string" || !Number.isFinite(Date.parse(snap.fetchedAt))) {
    problems.push("bad fetchedAt");
  }
  const grid = snap?.grid;
  const arrays = ["lon", "lat", "tec", "anomaly", "hmF2", "nmF2"].map((k) => grid?.[k]);
  if (!arrays.every(Array.isArray)) {
    problems.push("grid arrays missing");
  } else {
    const n = arrays[0].length;
    if (!arrays.every((a) => a.length === n)) problems.push("grid arrays differ in length");
    if (n < MIN_SNAPSHOT_POINTS) problems.push(`only ${n} grid points`);
    if (!arrays.every((a) => a.every(Number.isFinite))) problems.push("non-finite grid values");
  }
  const stats = snap?.stats;
  if (!stats || !Number.isFinite(stats?.tec?.max) || !Number.isFinite(stats?.tec?.min)) {
    problems.push("stats missing");
  }
  if (problems.length) {
    throw Object.assign(new Error(`tec_snapshot_invalid: ${problems.join("; ")}`), { status: 502 });
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
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok)
      throw Object.assign(new Error(`tec_snapshot_http_${res.status}`), { status: 502 });
    const text = await readResponseTextCapped(res, BODY_CAP_BYTES); // throws when too large
    const snap = JSON.parse(text);
    validateTecSnapshot(snap); // throws {status:502} on a corrupt asset — an upstream failure
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
      upstreamFile: snap.upstreamFile,
      upstreamUrl: snap.upstreamUrl,
      fetchedAt: snap.fetchedAt,
      pointCount: snap.pointCount,
      strideLat: snap.strideLat,
      strideLon: snap.strideLon,
      gridPoints: snap.gridPoints,
    },
    stats: snap.stats,
    grid: snap.grid,
    attribution:
      "Ionosphere TEC: NOAA SWPC GloTEC (public domain). " +
      "Snapshot: pre-downsampled by scripts/tec-snapshot.mjs from the live 2.4 MB GeoJSON.",
  };
}

async function getPayload(fetchImpl, nowMs, signal) {
  // nowMs is the injected clock (tests control it); real Date.now() is never
  // used for cache age so staleness is deterministic under test.
  if (cache && nowMs - cache.at < CACHE_TTL_MS) return buildPayload(cache.payload, nowMs, false);
  signal?.throwIfAborted?.();
  if (!inflight) {
    if (nowMs - attemptedAt < RETRY_COOLDOWN_MS) throw new Error("tec_retry_later");
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
    const abort = () => reject(signal.reason ?? new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    const detach = () => signal.removeEventListener("abort", abort);
    inflight.then(detach, detach);
  });
  return Promise.race([inflight, cancelled]);
}

function sendJson(res, status, body, cacheControl = "public, max-age=600") {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheControl,
  });
  res.end(JSON.stringify(body));
}

export function tecProxy({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  async function handler(req, res) {
    if (req.method !== "GET")
      return sendJson(res, 405, { error: "method_not_allowed" }, "no-store");
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.("close", close);
    try {
      try {
        sendJson(res, 200, await getPayload(fetchImpl, now(), controller.signal));
      } catch (error) {
        const usable = cache && now() - cache.at <= STALE_MS;
        if (usable) {
          sendJson(res, 200, buildPayload(cache.payload, now(), true));
          return;
        }
        const upstreamFail =
          error?.status === 502 ||
          error?.name === "AbortError" ||
          /aborted?/i.test(error?.message ?? "");
        sendJson(
          res,
          upstreamFail ? 502 : 500,
          { error: "tec_unavailable", detail: error?.message ?? "unknown" },
          "no-store",
        );
      }
    } finally {
      res.removeListener?.("close", close);
    }
  }

  return {
    name: "tec",
    configureServer({ middlewares }) {
      middlewares.use("/api/tec", handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use("/api/tec", handler);
    },
  };
}

export const _tecInternals = {
  SNAPSHOT_URL,
  parseGloTecGeoJson,
  downsampleTec,
  computeTecStats,
  buildTecSnapshot,
  validateTecSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
    attemptedAt = -Infinity;
  },
};
