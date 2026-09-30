/**
 * Wave 9 (R2-3) — SNOTEL snowpack provider.
 *
 * Backlog R2-3 ("SNOTEL snowpack"): USDA NRCS Air & Water Database (AWDB)
 * SOAP web service — the SNOTEL telemetry network (mountain snowpack,
 * free, keyless). Station discovery ran live from the build VM
 * (2026-09-30): getStations (western US bbox) → 846 SNOTEL triplets,
 * getStationMetadataMultiple → 18-station pinned spread across WA/OR/CA/
 * ID/MT/WY/CO/UT/NV (names, lat, lon, elevation all live-verified).
 * getData WTEQ + SNWD verified live the same day: 18 returns each, 11
 * daily values, real early-season signal (e.g. Apishapa CO 0.1–0.2 in
 * WTEQ / 1–2 in SNWD on 2026-09-20..30 — first snow of the season).
 *
 * HONESTY, stated on the payload:
 *  - WTEQ = snow water equivalent (inches), SNWD = snow depth (inches),
 *    daily readings from the USDA NRCS sensors. 0.0/0 = the sensor
 *    reported no snow — a real reading, not missing data. Early-season
 *    zeros are expected, not an error.
 *  - Missing days or unresponsive stations render as null — never 0
 *    (numOrNull guards the Number('')===0 trap everywhere).
 *  - latestDate = the last day of the 11-day window we requested; values
 *    are daily telemetry we re-serve, never measurements we took.
 *
 * Routes:
 *   GET /api/snotel → { generatedAt, stale, count, requestedNotFound,
 *     summary, stations, attribution, honesty }
 * Query: ?station=302:OR:SNTL (single-station lookup; unknown-but-
 *   wellformed triplet → 200 + requestedNotFound:true; malformed → 400).
 *
 * Pages-safe: global fetch only, capped 256 KB reads, redirect:'follow'
 * (workerd supports only 'follow'/'manual'; 'error' throws at the edge —
 * main 2ec4053), no node: imports, no WASM. 2 SOAP POSTs per refresh
 * (WTEQ + SNWD) — far under the Workers subrequest headroom rule.
 */

import { readResponseTextCapped } from "../common/http.js";

const USER_AGENT = "satwq-reality-os/1.0 (gods-eye-view; SNOTEL snowpack layer; keyless)";
const AWDB_SOAP = "https://wcc.sc.egov.usda.gov/awdbWebService/services"; // from the live WSDL, 2026-09-30
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 256 * 1024; // observed ~7 KB/element; generous headroom
const CACHE_TTL_MS = 3_600_000; // snowpack is slow; hourly refresh
const RETRY_COOLDOWN_MS = 60_000;
const STALE_MS = 12 * 3_600_000; // serve key-scoped stale ≤12 h on total outage
const WINDOW_DAYS = 11;

const ELEMENTS = ["WTEQ", "SNWD"];
const ELEMENT_UNITS = { WTEQ: "in (snow water equivalent)", SNWD: "in (snow depth)" };

// 18-station pinned spread. All metadata live-verified 2026-09-30 via
// getStationMetadataMultiple (see probes-2026-09-30-0813/meta-multi-resp.xml).
const STATIONS = [
  { triplet: "908:WA:SNTL", name: "Alpine Meadows", state: "WA", lat: 47.77957, lon: -121.69847, elevationFt: 3500 },
  { triplet: "990:WA:SNTL", name: "Beaver Pass", state: "WA", lat: 48.8793, lon: -121.2555, elevationFt: 3630 },
  { triplet: "302:OR:SNTL", name: "Aneroid Lake #2", state: "OR", lat: 45.21332, lon: -117.19255, elevationFt: 7430 },
  { triplet: "1000:OR:SNTL", name: "Annie Springs", state: "OR", lat: 42.87007, lon: -122.16518, elevationFt: 6020 },
  { triplet: "301:CA:SNTL", name: "Adin Mtn", state: "CA", lat: 41.23583, lon: -120.79192, elevationFt: 6170 },
  { triplet: "356:CA:SNTL", name: "Blue Lakes", state: "CA", lat: 38.60801, lon: -119.92455, elevationFt: 8060 },
  { triplet: "306:ID:SNTL", name: "Atlanta Summit", state: "ID", lat: 43.7569, lon: -115.23907, elevationFt: 7570 },
  { triplet: "312:ID:SNTL", name: "Banner Summit", state: "ID", lat: 44.30342, lon: -115.23447, elevationFt: 7040 },
  { triplet: "916:MT:SNTL", name: "Albro Lake", state: "MT", lat: 45.59723, lon: -111.95902, elevationFt: 8500 },
  { triplet: "307:MT:SNTL", name: "Badger Pass", state: "MT", lat: 48.13091, lon: -113.02311, elevationFt: 6870 },
  { triplet: "309:WY:SNTL", name: "Bald Mtn.", state: "WY", lat: 44.80061, lon: -107.84428, elevationFt: 9360 },
  { triplet: "314:WY:SNTL", name: "Base Camp", state: "WY", lat: 43.94019, lon: -110.44544, elevationFt: 7040 },
  { triplet: "1344:CO:SNTL", name: "Alta Lakes", state: "CO", lat: 37.88929, lon: -107.84484, elevationFt: 11290 },
  { triplet: "303:CO:SNTL", name: "Apishapa", state: "CO", lat: 37.33067, lon: -105.06766, elevationFt: 10000 },
  { triplet: "907:UT:SNTL", name: "Agua Canyon", state: "UT", lat: 37.52217, lon: -112.27118, elevationFt: 8890 },
  { triplet: "1308:UT:SNTL", name: "Atwater", state: "UT", lat: 40.59124, lon: -111.63775, elevationFt: 8750 },
  { triplet: "321:NV:SNTL", name: "Bear Creek", state: "NV", lat: 41.83391, lon: -115.45278, elevationFt: 8090 },
  { triplet: "334:NV:SNTL", name: "Berry Creek", state: "NV", lat: 39.31917, lon: -114.62278, elevationFt: 9350 },
];

const TRIPLET_RE = /^\d{1,4}:[A-Z]{2}:SNTL$/;

let docCache = null; // {at, rows} — one refresh serves ALL query keys
let docInflight = null;
let docFailedAt = -Infinity;
const payloadCache = new Map();
const PAYLOAD_CACHE_MAX = 32;

/** Number(null)===0 guard: null/NaN upstream numerics become null, never 0. */
function numOrNull(v) {
  if (v == null) return null;
  if (typeof v === "string" && v.trim() === "") return null; // Number('')===0 trap
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** UTC YYYY-MM-DD for a timestamp. */
function ymd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The 11-day telemetry window ending today (UTC). Pure. */
export function windowDates(nowMs) {
  const endDate = ymd(nowMs);
  const beginDate = ymd(nowMs - (WINDOW_DAYS - 1) * 86_400_000);
  return { beginDate, endDate };
}

/**
 * Build the AWDB getData SOAP envelope for one element over the pinned
 * station list. Pure. Triplets are live-verified constants — no escaping
 * hazard; dates are generated, never user-supplied.
 */
export function buildGetDataEnvelope(triplets, elementCd, beginDate, endDate) {
  const trips = triplets.map((t) => `      <stationTriplets>${t}</stationTriplets>`).join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:tns="http://www.wcc.nrcs.usda.gov/ns/awdbWebService">\n` +
    `  <soap:Body>\n` +
    `    <tns:getData>\n${trips}\n` +
    `      <elementCd>${elementCd}</elementCd>\n` +
    `      <ordinal>1</ordinal>\n` +
    `      <duration>DAILY</duration>\n` +
    `      <getFlags>false</getFlags>\n` +
    `      <beginDate>${beginDate}</beginDate>\n` +
    `      <endDate>${endDate}</endDate>\n` +
    `    </tns:getData>\n` +
    `  </soap:Body>\n` +
    `</soap:Envelope>\n`
  );
}

/**
 * Parse an AWDB getDataResponse envelope. workerd has no DOMParser —
 * anchored regexes on the observed wire format (verified live
 * 2026-09-30): <return> blocks each carrying stationTriplet, beginDate,
 * endDate, and one <values> per day. Returns [{stationTriplet,
 * beginDate, endDate, values}]. Throws {status:502} when the doc is not
 * a getDataResponse at all (incl. SOAP Faults).
 */
export function parseGetDataResponse(text) {
  const fail = (msg) => Object.assign(new Error(`snotel_invalid_getdata: ${msg}`), { status: 502 });
  if (typeof text !== "string" || !text.includes("<ns2:getDataResponse") && !text.includes("getDataResponse")) {
    throw fail("not a getDataResponse");
  }
  if (/<soap:Fault>/.test(text)) throw fail("soap fault");
  const rows = [];
  const blockRe = /<return>([\s\S]*?)<\/return>/g;
  let block;
  while ((block = blockRe.exec(text)) !== null) {
    const body = block[1];
    const tag = (name) => {
      const m = new RegExp(`<([^>:]*:)?${name}>([^<]*)<\\/`).exec(body);
      return m ? m[2].trim() : null;
    };
    const stationTriplet = tag("stationTriplet");
    if (stationTriplet == null) continue;
    const values = [];
    const valueRe = /<values>([\s\S]*?)<\/values>/g;
    let vm;
    while ((vm = valueRe.exec(body)) !== null) values.push(numOrNull(vm[1].trim()));
    rows.push({
      stationTriplet,
      beginDate: tag("beginDate"),
      endDate: tag("endDate"),
      values,
    });
  }
  if (rows.length === 0) throw fail("no <return> blocks");
  return rows;
}

function parseQuery(url) {
  const params = new URL(url, "http://localhost").searchParams;
  const stationRaw = params.get("station");
  let station = null;
  if (stationRaw != null) {
    station = stationRaw.trim().toUpperCase();
    if (!TRIPLET_RE.test(station))
      throw Object.assign(new Error(`snotel_bad_station: ${stationRaw}`), { status: 400 });
  }
  return { station, key: station ?? "" };
}

async function fetchWithTimeout(fetchImpl, url, { body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "text/xml; charset=utf-8",
        Accept: "text/xml",
      },
      body,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** One element: POST the envelope, parse, index by triplet. Throws {status:502} on failure. */
async function fetchElement(fetchImpl, elementCd, nowMs) {
  const { beginDate, endDate } = windowDates(nowMs);
  const envelope = buildGetDataEnvelope(STATIONS.map((s) => s.triplet), elementCd, beginDate, endDate);
  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, AWDB_SOAP, { body: envelope });
  } catch (error) {
    throw Object.assign(new Error(`snotel_fetch_failed:${elementCd}`), { status: 502, cause: error });
  }
  if (!res.ok) throw Object.assign(new Error(`snotel_http_${res.status}:${elementCd}`), { status: 502 });
  let text;
  try {
    text = await readResponseTextCapped(res, BODY_CAP_BYTES);
  } catch (error) {
    throw Object.assign(new Error(`snotel_read_failed:${elementCd}`), { status: 502, cause: error });
  }
  const rows = parseGetDataResponse(text); // throws {status:502} on bad wire shape
  const byTriplet = new Map();
  for (const row of rows) byTriplet.set(row.stationTriplet, row);
  return { byTriplet, beginDate, endDate };
}

/** Merge WTEQ + SNWD rows into per-station records. Pure. */
export function mergeStations(stations, wteqBy, snwdBy, { beginDate, endDate }) {
  return stations.map((spec) => {
    const wteq = wteqBy.get(spec.triplet);
    const snwd = snwdBy.get(spec.triplet);
    const dates = [];
    for (let i = 0; i < WINDOW_DAYS; i++) {
      dates.push(ymd(Date.parse(`${beginDate}T00:00:00Z`) + i * 86_400_000));
    }
    const pad = (vals) => {
      const out = (vals ?? []).slice(0, WINDOW_DAYS);
      while (out.length < WINDOW_DAYS) out.push(null);
      return out;
    };
    const wteqVals = pad(wteq?.values);
    const snwdVals = pad(snwd?.values);
    // Latest = last non-null value in the window (trailing nulls are
    // unreported days, not zeros — never walk past the data into a 0).
    const latest = (vals) => {
      for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return { value: vals[i], date: dates[i] };
      return { value: null, date: null };
    };
    const latestWteq = latest(wteqVals);
    const latestSnwd = latest(snwdVals);
    const daysWithData = wteqVals.filter((v) => v != null).length;
    return {
      triplet: spec.triplet,
      name: spec.name,
      state: spec.state,
      lat: spec.lat,
      lon: spec.lon,
      elevationFt: spec.elevationFt,
      beginDate,
      endDate,
      latestDate: endDate,
      wteqIn: latestWteq.value,
      wteqDate: latestWteq.date,
      snwdIn: latestSnwd.value,
      snwdDate: latestSnwd.date,
      hasSnow: (latestWteq.value ?? 0) > 0 || (latestSnwd.value ?? 0) > 0,
      daysWithData,
      wteqUnavailable: wteq == null,
      snwdUnavailable: snwd == null,
    };
  });
}

/** Build the publishable payload from per-station records. Pure. */
export function buildSnotelPayload(merged, { nowMs, query, window }) {
  let stations = merged;
  let requestedNotFound = false;
  if (query.station) {
    const match = merged.find((r) => r.triplet === query.station);
    stations = match ? [match] : [];
    requestedNotFound = !match;
  }
  const withSnow = merged.filter((r) => r.hasSnow).length;
  const withData = merged.filter((r) => r.daysWithData > 0).length;
  let maxSnwd = null;
  for (const r of merged) {
    if (r.snwdIn != null && (maxSnwd == null || r.snwdIn > maxSnwd.value)) {
      maxSnwd = { value: r.snwdIn, station: `${r.name}, ${r.state}`, triplet: r.triplet };
    }
  }
  return {
    generatedAt: new Date(nowMs).toISOString(),
    stale: false,
    count: stations.length,
    requestedNotFound,
    window,
    summary: {
      total: merged.length,
      withData,
      withSnow,
      maxSnwdIn: maxSnwd?.value ?? null,
      maxSnwdStation: maxSnwd?.station ?? null,
      elements: { WTEQ: ELEMENT_UNITS.WTEQ, SNWD: ELEMENT_UNITS.SNWD },
    },
    stations,
    attribution:
      "SNOTEL mountain snowpack telemetry: USDA NRCS Air & Water Database " +
      "(AWDB) SOAP service, keyless. 18 pinned western-US stations " +
      "(metadata live-verified 2026-09-30). WTEQ = snow water equivalent " +
      "(in), SNWD = snow depth (in), daily. 11-day window ending today (UTC).",
    honesty:
      "Values are daily sensor telemetry re-served, never measurements we " +
      "took. 0 = the sensor reported no snow (a real reading — early-season " +
      "zeros are expected, not an error). null = no value returned for that " +
      "day. A station dark on both elements still lists with *_unavailable " +
      "flags — never synthesized.",
  };
}

async function fetchAll(fetchImpl, nowMs) {
  const { beginDate, endDate } = windowDates(nowMs);
  const results = await Promise.allSettled(
    ELEMENTS.map((elementCd) => fetchElement(fetchImpl, elementCd, nowMs)),
  );
  const wteq = results[0].status === "fulfilled" ? results[0].value : null;
  const snwd = results[1].status === "fulfilled" ? results[1].value : null;
  // Total upstream outage (both elements unreachable) is a provider-level
  // failure → honest 502, matching the d99a470 precedent. Partial
  // degradation stays a 200 with *_unavailable flags.
  if (!wteq && !snwd) {
    throw Object.assign(new Error("snotel_upstream_down: WTEQ and SNWD unreachable"), { status: 502 });
  }
  const merged = mergeStations(STATIONS, wteq?.byTriplet ?? new Map(), snwd?.byTriplet ?? new Map(), {
    beginDate,
    endDate,
  });
  return { merged, window: { beginDate, endDate } };
}

function sendJson(res, status, body, cacheControl = "public, max-age=3600") {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheControl,
  });
  res.end(JSON.stringify(body));
}

async function getDoc(fetchImpl, nowMs, signal) {
  if (docCache && nowMs - docCache.at < CACHE_TTL_MS) return docCache;
  signal?.throwIfAborted?.();
  if (!docInflight) {
    // Retry gate fires only after a FAILED refresh — a success on one
    // query key must never block a different key (one refresh serves all).
    if (nowMs - docFailedAt < RETRY_COOLDOWN_MS) throw new Error("snotel_retry_later");
    docInflight = fetchAll(fetchImpl, nowMs)
      .then((doc) => {
        docCache = { ...doc, at: nowMs };
        docFailedAt = -Infinity;
        return docCache;
      })
      .catch((error) => {
        docFailedAt = nowMs;
        throw error;
      })
      .finally(() => {
        docInflight = null;
      });
  }
  const wait = docInflight;
  if (!signal) return wait;
  const cancelled = new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    const detach = () => signal.removeEventListener("abort", abort);
    wait.then(detach, detach);
  });
  return Promise.race([wait, cancelled]);
}

function rememberPayload(key, payload, nowMs) {
  payloadCache.set(key, { at: nowMs, payload });
  while (payloadCache.size > PAYLOAD_CACHE_MAX) {
    const oldest = payloadCache.keys().next().value;
    payloadCache.delete(oldest);
  }
}

async function getPayload(fetchImpl, query, nowMs, signal) {
  try {
    const doc = await getDoc(fetchImpl, nowMs, signal);
    const payload = buildSnotelPayload(doc.merged, { nowMs, query, window: doc.window });
    rememberPayload(query.key, payload, nowMs);
    return payload;
  } catch (error) {
    // Stale fallback is key-scoped: only serve a payload captured for THIS query.
    const hit = payloadCache.get(query.key);
    if (hit && nowMs - hit.at <= STALE_MS)
      return { ...hit.payload, generatedAt: new Date(nowMs).toISOString(), stale: true };
    throw error;
  }
}

export function snotelProxy({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  async function handler(req, res) {
    if (req.method !== "GET")
      return sendJson(res, 405, { error: "method_not_allowed" }, "no-store");
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.("close", close);
    try {
      let query;
      try {
        query = parseQuery(req.url);
      } catch (error) {
        return sendJson(res, 400, { error: "snotel_bad_request", detail: error.message }, "no-store");
      }
      try {
        const payload = await getPayload(fetchImpl, query, now(), controller.signal);
        sendJson(res, 200, payload);
      } catch (error) {
        const upstreamFail =
          error?.status === 502 ||
          error?.name === "AbortError" ||
          /aborted?|fetch failed/i.test(error?.message ?? "");
        sendJson(
          res,
          upstreamFail ? 502 : 500,
          { error: "snotel_unavailable", detail: error?.message ?? "unknown" },
          "no-store",
        );
      }
    } finally {
      res.removeListener?.("close", close);
    }
  }

  return {
    name: "snotel",
    configureServer({ middlewares }) {
      middlewares.use("/api/snotel", handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use("/api/snotel", handler);
    },
  };
}

export const _snotelInternals = {
  STATIONS,
  ELEMENTS,
  WINDOW_DAYS,
  numOrNull,
  windowDates,
  buildGetDataEnvelope,
  parseGetDataResponse,
  mergeStations,
  buildSnotelPayload,
  clearCaches: () => {
    docCache = null;
    docInflight = null;
    docFailedAt = -Infinity;
    payloadCache.clear();
  },
};
