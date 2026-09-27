/**
 * Wave 6 — magnetometer / riometer layer (keyless).
 *
 * Merges two ground-magnetic data sources into one trimmed document:
 *
 *   #39 IRF maggraphs  https://www.irf.se/maggraphs/sgu1/lycksele.png
 *                       (sgu2 variant also listed) — manifest entries; image
 *                       bytes are loaded client-side, never proxied.
 *   #45–46 UCalgary HAPI  https://api.phys.ucalgary.ca/hapi/ — proper HAPI 3.3
 *                       API. The catalog and the live endpoint both show 46
 *                       datasets: NORSTAR riometers (K0 raw signal, K2
 *                       absorption) + SWAN HSR raw power. No vector
 *                       magnetometer datasets are exposed on this endpoint —
 *                       that is reported honestly, not papered over.
 *
 * The provider samples one NORSTAR riometer (K0@GILL, raw_signal) and one
 * SWAN HSR (K0@CHUR, raw_power) over a 1-hour window ~2 days back (the
 * archive lags ~1 day; window is reported in the payload), decimates to
 * ≤48 points, and returns summary stats.
 *
 * Routes:
 *   GET /api/magnetometers → {generatedAt, sources:{…}, irf:{…}, hapi:{…}}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 *
 * Probe notes (2026-09-27, build VM): HAPI catalog/data → 200 (46 datasets
 * listed, sample rows parsed); irf.se → curl 000 (VM-throttled, needs
 * Worker probe) — recorded as probe:'vm-000', included not broken.
 */

const HAPI_BASE = "https://api.phys.ucalgary.ca/hapi";
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 512 * 1024;
const CACHE_TTL_MS = 15 * 60_000;
const MAX_SERIES_POINTS = 48;
const USER_AGENT = "Gods Eye View (magnetometer layer)";

const HAPI_DATASETS = [
  {
    id: "NORSTAR_RIOMETER_K0@GILL",
    parameter: "raw_signal",
    title: "NORSTAR Riometer K0 raw signal — Gillam",
  },
  {
    id: "SWAN_HSR_K0@CHUR",
    parameter: "raw_power",
    title: "SWAN HSR K0 raw power — Churchill",
  },
];

const IRF_PLOTS = [
  {
    id: "irf-sgu1-lycksele",
    name: "IRF maggraph — Lycksele (SGU1)",
    url: "https://www.irf.se/maggraphs/sgu1/lycksele.png",
    format: "PNG",
    cadence: "rolling",
    attribution: "Swedish Institute of Space Physics / SGU",
    license: "IRF/SGU attribution",
    probe: "vm-000",
  },
  {
    id: "irf-sgu2-lycksele",
    name: "IRF maggraph — Lycksele (SGU2)",
    url: "https://www.irf.se/maggraphs/sgu2/lycksele.png",
    format: "PNG",
    cadence: "rolling",
    attribution: "Swedish Institute of Space Physics / SGU",
    license: "IRF/SGU attribution",
    probe: "vm-000",
  },
];

let cache = null; // {at, payload}
let inflight = null;

/**
 * Parse HAPI CSV-with-#-header. Columns: Time, then parameters in order
 * with binned params expanded. Returns {units, description, times, series}
 * where series rows are arrays of the primary parameter's values.
 */
export function parseHapiCsv(text, primaryParam) {
  const headerLines = [];
  const dataLines = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line) continue;
    if (line.startsWith("#")) headerLines.push(line.replace(/^#\s?/, ""));
    else dataLines.push(line);
  }
  if (dataLines.length === 0) throw new Error("magnetometers_hapi_no_data");
  let params = [];
  try {
    params = JSON.parse(headerLines.join("\n"))?.parameters ?? [];
  } catch {
    params = [];
  }
  // Column offset of the primary parameter: 1 (Time occupies CSV column 0
  // and is also listed in the HAPI header — it must NOT advance the offset).
  let col = 1;
  let size = 1;
  let units = null;
  let description = null;
  for (const p of params) {
    if (p?.name === primaryParam) {
      const s = Array.isArray(p?.size) ? p.size[0] : 1;
      size = Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) : 1;
      units = p?.units ?? null;
      description = p?.description ?? null;
      break;
    }
    if (p?.type === "isotime" || /^time$/i.test(String(p?.name ?? "")))
      continue;
    const ps = Array.isArray(p?.size) ? Number(p.size[0]) : 1;
    col += Number.isFinite(ps) && ps > 0 ? ps : 1;
  }
  const rows = [];
  for (const line of dataLines) {
    const parts = line.split(",");
    const t = Date.parse(parts[0]);
    if (!Number.isFinite(t)) continue;
    const vals = parts
      .slice(col, col + size)
      .map(Number)
      .filter(Number.isFinite);
    if (vals.length === 0) continue;
    rows.push({ t, vals });
  }
  if (rows.length === 0) throw new Error("magnetometers_hapi_no_rows");
  const step = Math.max(1, Math.ceil(rows.length / MAX_SERIES_POINTS));
  const series = rows
    .filter((_, i) => i % step === 0)
    .map((r) => ({
      t: new Date(r.t).toISOString(),
      v: r.vals.length === 1 ? r.vals[0] : r.vals,
    }));
  const flat = rows.flatMap((r) => r.vals);
  const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
  return {
    units,
    description,
    sampleCount: rows.length,
    latestTime: new Date(rows[rows.length - 1].t).toISOString(),
    latest: rows[rows.length - 1].vals,
    min: Math.min(...flat),
    max: Math.max(...flat),
    mean,
    series,
  };
}

async function fetchTextCapped(fetchImpl, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/csv, */*" },
    });
    if (!response.ok)
      throw Object.assign(new Error(`magnetometers_hapi_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error("magnetometers_hapi_too_large"), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

function hapiWindow(nowMs) {
  // Archive lags ~1 day: sample a 1-hour window ending 49h ago.
  const stop = new Date(nowMs - 49 * 3600_000);
  const start = new Date(stop.getTime() - 3600_000);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, ".000Z");
  return { start: iso(start), stop: iso(stop) };
}

async function fetchHapiDataset(fetchImpl, ds, window) {
  const started = Date.now();
  const url =
    `${HAPI_BASE}/data?dataset=${encodeURIComponent(ds.id)}` +
    `&start=${encodeURIComponent(window.start)}&stop=${encodeURIComponent(window.stop)}` +
    `&parameters=${encodeURIComponent(ds.parameter)}&include=header`;
  try {
    const text = await fetchTextCapped(fetchImpl, url);
    const parsed = parseHapiCsv(text, ds.parameter);
    return {
      datasetId: ds.id,
      title: ds.title,
      ok: true,
      windowStart: window.start,
      windowStop: window.stop,
      units: parsed.units,
      sampleCount: parsed.sampleCount,
      latestTime: parsed.latestTime,
      latest: parsed.latest,
      min: parsed.min,
      max: parsed.max,
      mean: parsed.mean,
      series: parsed.series,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      datasetId: ds.id,
      title: ds.title,
      ok: false,
      error: error?.message ?? "unknown",
      latencyMs: Date.now() - started,
    };
  }
}

function buildSnapshot(results, window) {
  const ok = results.filter((r) => r.ok);
  const sources = {
    irf: {
      ok: true,
      count: IRF_PLOTS.length,
      attribution: "Swedish Institute of Space Physics / SGU",
      note: "manifest entries; image bytes load client-side. irf.se unreachable from build VM (vm-000, needs Worker probe).",
    },
    hapi: {
      ok: ok.length > 0,
      liveCount: ok.length,
      requested: results.length,
      attribution: "University of Calgary (NORSTAR/SWAN); cite dataset DOI",
      note: "HAPI 3.3 endpoint exposes NORSTAR riometers + SWAN HSR raw power only — no vector magnetometer datasets.",
      ...(!ok.length && results.length
        ? { error: results.map((r) => `${r.datasetId}:${r.error}`).join("; ") }
        : {}),
    },
  };
  return {
    generatedAt: new Date().toISOString(),
    sources,
    irf: { plots: IRF_PLOTS.map((p) => ({ ...p })) },
    hapi: {
      windowStart: window.start,
      windowStop: window.stop,
      datasets: results,
    },
  };
}

async function getSnapshot(fetchImpl, nowMs) {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = (async () => {
      const window = hapiWindow(nowMs);
      const results = await Promise.all(
        HAPI_DATASETS.map((ds) => fetchHapiDataset(fetchImpl, ds, window)),
      );
      const payload = buildSnapshot(results, window);
      cache = { at: Date.now(), payload };
      return payload;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = "public, max-age=900") {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheControl,
  });
  res.end(JSON.stringify(body));
}

export function magnetometersProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  async function handler(req, res) {
    if (req.method !== "GET")
      return sendJson(res, 405, { error: "method_not_allowed" }, "no-store");
    try {
      sendJson(res, 200, await getSnapshot(fetchImpl, now()));
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === "AbortError" ||
        /aborted?/i.test(error?.message ?? "");
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: "magnetometers_unavailable",
          detail: error?.message ?? "unknown",
        },
        "no-store",
      );
    }
  }

  return {
    name: "magnetometers",
    configureServer({ middlewares }) {
      middlewares.use("/api/magnetometers", handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use("/api/magnetometers", handler);
    },
  };
}

export const _magnetometersInternals = {
  HAPI_DATASETS,
  IRF_PLOTS,
  parseHapiCsv,
  hapiWindow,
  buildSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
