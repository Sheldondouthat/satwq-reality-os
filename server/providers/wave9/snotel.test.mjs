/**
 * snotel.test.mjs — USDA NRCS AWDB SNOTEL provider tests.
 *
 * Parser fixtures are REAL response bytes (2026-09-30, build VM):
 * WTEQ + SNWD getData responses for 908:WA:SNTL (Alpine Meadows),
 * 302:OR:SNTL (Aneroid Lake #2), 303:CO:SNTL (Apishapa — the live
 * 0.1–0.2 in WTEQ / 1–2 in SNWD early-season snow). Envelope header
 * carried verbatim; 3 of 18 <return> blocks each.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  snotelProxy,
  _snotelInternals,
} from "./snotel.js";

const {
  STATIONS,
  WINDOW_DAYS,
  numOrNull,
  windowDates,
  buildGetDataEnvelope,
  parseGetDataResponse,
  mergeStations,
  buildSnotelPayload,
  clearCaches,
} = _snotelInternals;

// --- REAL WIRE FIXTURES (live bytes, 2026-09-30) ---
const WTEQ_LIVE = "<soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><soap:Body><ns2:getDataResponse xmlns:ns2=\"http://www.wcc.nrcs.usda.gov/ns/awdbWebService\"><return><beginDate>2026-09-20 00:00:00</beginDate><duration>DAILY</duration><endDate>2026-09-30 00:00:00</endDate><stationTriplet>908:WA:SNTL</stationTriplet><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values></return><return><beginDate>2026-09-20 00:00:00</beginDate><duration>DAILY</duration><endDate>2026-09-30 00:00:00</endDate><stationTriplet>302:OR:SNTL</stationTriplet><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values><values>0.0</values><values>0.1</values><values>0.1</values></return><return><beginDate>2026-09-20 00:00:00</beginDate><duration>DAILY</duration><endDate>2026-09-30 00:00:00</endDate><stationTriplet>303:CO:SNTL</stationTriplet><values>0.0</values><values>0.0</values><values>0.1</values><values>0.1</values><values>0.2</values><values>0.2</values><values>0.1</values><values>0.1</values><values>0.1</values><values>0.2</values><values>0.2</values></return></ns2:getDataResponse></soap:Body></soap:Envelope>";
const SNWD_LIVE = "<soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><soap:Body><ns2:getDataResponse xmlns:ns2=\"http://www.wcc.nrcs.usda.gov/ns/awdbWebService\"><return><beginDate>2026-09-20 00:00:00</beginDate><duration>DAILY</duration><endDate>2026-09-30 00:00:00</endDate><stationTriplet>908:WA:SNTL</stationTriplet><values>0</values><values>0</values><values>0</values><values>0</values><values>0</values><values>0</values><values>1</values><values>1</values><values>1</values><values>1</values><values>1</values></return><return><beginDate>2026-09-20 00:00:00</beginDate><duration>DAILY</duration><endDate>2026-09-30 00:00:00</endDate><stationTriplet>302:OR:SNTL</stationTriplet><values>0</values><values>0</values><values>0</values><values>0</values><values>0</values><values>0</values><values>0</values><values>0</values><values>0</values><values>0</values><values>0</values></return><return><beginDate>2026-09-20 00:00:00</beginDate><duration>DAILY</duration><endDate>2026-09-30 00:00:00</endDate><stationTriplet>303:CO:SNTL</stationTriplet><values>0</values><values>0</values><values>1</values><values>2</values><values>2</values><values>2</values><values>1</values><values>1</values><values>2</values><values>2</values><values>2</values></return></ns2:getDataResponse></soap:Body></soap:Envelope>";

const FAULT_LIVE_SHAPE =
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
  "<soap:Fault><faultcode>soap:Server</faultcode><faultstring>boom</faultstring></soap:Fault>" +
  "</soap:Body></soap:Envelope>";

test("numOrNull: null/NaN/empty never become 0 (Number('')===0 trap)", () => {
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(""), null);
  assert.equal(numOrNull("   "), null);
  assert.equal(numOrNull("abc"), null);
  assert.equal(numOrNull(0), 0);
  assert.equal(numOrNull("0.0"), 0);
  assert.equal(numOrNull("0.1"), 0.1);
  assert.equal(numOrNull("2"), 2);
});

test("windowDates: 11-day window ending today (UTC)", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const { beginDate, endDate } = windowDates(now);
  assert.equal(beginDate, "2026-09-20");
  assert.equal(endDate, "2026-09-30");
});

test("buildGetDataEnvelope: pins all 18 triplets + element + dates", () => {
  const trips = STATIONS.map((s) => s.triplet);
  const xml = buildGetDataEnvelope(trips, "WTEQ", "2026-09-20", "2026-09-30");
  assert.ok(xml.includes("<elementCd>WTEQ</elementCd>"));
  assert.ok(xml.includes("<duration>DAILY</duration>"));
  assert.ok(xml.includes("<beginDate>2026-09-20</beginDate>"));
  assert.ok(xml.includes("<endDate>2026-09-30</endDate>"));
  for (const t of trips) assert.ok(xml.includes(`<stationTriplets>${t}</stationTriplets>`), t);
  assert.equal((xml.match(/<stationTriplets>/g) || []).length, 18);
});

test("parseGetDataResponse: real WTEQ wire bytes", () => {
  const rows = parseGetDataResponse(WTEQ_LIVE);
  assert.equal(rows.length, 3);
  const byTrip = new Map(rows.map((r) => [r.stationTriplet, r]));
  assert.equal(byTrip.get("908:WA:SNTL").values.length, 11);
  assert.ok(byTrip.get("908:WA:SNTL").values.every((v) => v === 0));
  // 302:OR:SNTL (Aneroid Lake #2): last two days 0.1 in — early-season SWE.
  assert.deepEqual(byTrip.get("302:OR:SNTL").values.slice(-3), [0, 0.1, 0.1]);
  // 303:CO:SNTL (Apishapa): live early-season snow, real varying values.
  const api = byTrip.get("303:CO:SNTL").values;
  assert.ok(api.filter((v) => v > 0).length >= 5, "Apishapa WTEQ has nonzero values");
  assert.ok(api.every((v) => v === 0 || v === 0.1 || v === 0.2));
});

test("parseGetDataResponse: real SNWD wire bytes", () => {
  const rows = parseGetDataResponse(SNWD_LIVE);
  assert.equal(rows.length, 3);
  const byTrip = new Map(rows.map((r) => [r.stationTriplet, r]));
  // 303:CO:SNTL snow depth: 0,0,1,2,2,2,1,1,2,2,2 — integer inches, real.
  assert.deepEqual(byTrip.get("303:CO:SNTL").values, [0, 0, 1, 2, 2, 2, 1, 1, 2, 2, 2]);
  // 908:WA:SNTL: 1 in on the last five days.
  assert.deepEqual(byTrip.get("908:WA:SNTL").values.slice(-5), [1, 1, 1, 1, 1]);
});

test("parseGetDataResponse: SOAP Fault -> 502", () => {
  assert.throws(() => parseGetDataResponse(FAULT_LIVE_SHAPE), (e) => e.status === 502);
});

test("parseGetDataResponse: garbage -> 502", () => {
  assert.throws(() => parseGetDataResponse("<html>not soap</html>"), (e) => e.status === 502);
  assert.throws(() => parseGetDataResponse(""), (e) => e.status === 502);
});

test("mergeStations: pads short windows with null, never zero-fills", () => {
  const specs = [STATIONS[0]]; // 908:WA:SNTL Alpine Meadows
  const wteqBy = new Map([
    ["908:WA:SNTL", { values: [0, 0, 0] }], // truncated window (3 days)
  ]);
  const rows = mergeStations(specs, wteqBy, new Map(), { beginDate: "2026-09-20", endDate: "2026-09-30" });
  const r = rows[0];
  assert.equal(r.wteqIn, 0); // last non-null = 0 (real reading)
  assert.equal(r.wteqDate, "2026-09-22");
  assert.equal(r.snwdIn, null); // element missing entirely -> null, not 0
  assert.equal(r.snwdUnavailable, true);
  assert.equal(r.wteqUnavailable, false);
  assert.equal(r.daysWithData, 3);
  assert.equal(r.hasSnow, false);
});

test("mergeStations: latest skips trailing nulls, honors real zeros", () => {
  const specs = [STATIONS[13]]; // 303:CO:SNTL Apishapa
  const wteqBy = new Map([["303:CO:SNTL", { values: [0.1, 0.2, null, null] }]]);
  const snwdBy = new Map([["303:CO:SNTL", { values: [1, 2, null, null] }]]);
  const rows = mergeStations(specs, wteqBy, snwdBy, { beginDate: "2026-09-20", endDate: "2026-09-30" });
  const r = rows[0];
  assert.equal(r.wteqIn, 0.2); // trailing nulls skipped, real 0.2 kept
  assert.equal(r.snwdIn, 2);
  assert.equal(r.hasSnow, true);
});

test("buildSnotelPayload: summary math + query filter + requestedNotFound", () => {
  const merged = mergeStations(
    STATIONS.slice(0, 3),
    new Map([
      ["908:WA:SNTL", { values: [0] }],
      ["990:WA:SNTL", { values: [0] }],
      ["302:OR:SNTL", { values: [0, 0.1] }],
    ]),
    new Map([
      ["908:WA:SNTL", { values: [0] }],
      ["990:WA:SNTL", { values: [0] }],
      ["302:OR:SNTL", { values: [0, 1] }],
    ]),
    { beginDate: "2026-09-20", endDate: "2026-09-30" },
  );
  const now = Date.parse("2026-09-30T12:00:00Z");
  const full = buildSnotelPayload(merged, { nowMs: now, query: { station: null }, window: { beginDate: "2026-09-20", endDate: "2026-09-30" } });
  assert.equal(full.count, 3);
  assert.equal(full.summary.total, 3);
  assert.equal(full.summary.withSnow, 1); // only 302:OR:SNTL
  assert.equal(full.summary.maxSnwdIn, 1);
  assert.ok(full.summary.maxSnwdStation.includes("Aneroid Lake #2"));
  assert.ok(full.attribution.includes("AWDB"));
  assert.ok(full.honesty.includes("never synthesized"));
  assert.equal(full.requestedNotFound, false);

  const one = buildSnotelPayload(merged, {
    nowMs: now,
    query: { station: "302:OR:SNTL" },
    window: { beginDate: "2026-09-20", endDate: "2026-09-30" },
  });
  assert.equal(one.count, 1);
  assert.equal(one.stations[0].name, "Aneroid Lake #2");
  assert.equal(one.requestedNotFound, false);

  const miss = buildSnotelPayload(merged, {
    nowMs: now,
    query: { station: "999:OR:SNTL" },
    window: { beginDate: "2026-09-20", endDate: "2026-09-30" },
  });
  assert.equal(miss.count, 0);
  assert.equal(miss.requestedNotFound, true);
});

test("stations: 18 pinned, all metadata present", () => {
  assert.equal(STATIONS.length, 18);
  const states = new Set(STATIONS.map((s) => s.state));
  assert.ok(states.size >= 8, "multi-state spread");
  for (const s of STATIONS) {
    assert.match(s.triplet, /^\d{1,4}:[A-Z]{2}:SNTL$/, s.name);
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lon), s.name);
    assert.ok(s.elevationFt > 1000, s.name);
    assert.ok(typeof s.name === "string" && s.name.length > 0);
  }
});

// --- live handler tests (fake fetch) ---

function makeFetch(textByElement, { failAll = false } = {}) {
  return async (url, opts) => {
    if (failAll) throw new Error("fetch failed");
    const body = opts?.body ?? "";
    const el = body.includes("<elementCd>SNWD</elementCd>") ? "SNWD" : "WTEQ";
    const text = textByElement[el];
    if (!text) throw new Error("fetch failed");
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/xml" },
      text: async () => text,
    };
  };
}

function req(path) {
  const headers = {};
  return {
    method: "GET",
    url: path,
    headers,
    once: () => {},
    removeListener: () => {},
  };
}

function res() {
  const chunks = [];
  return {
    statusCode: null,
    body: chunks,
    once: () => {},
    removeListener: () => {},
    writeHead(status) {
      this.statusCode = status;
    },
    end(data) {
      chunks.push(data);
    },
    json() {
      return JSON.parse(chunks.join(""));
    },
  };
}

test("handler: 200 with real fixture payloads", async () => {
  clearCaches();
  const proxy = snotelProxy({ fetchImpl: makeFetch({ WTEQ: WTEQ_LIVE, SNWD: SNWD_LIVE }) });
  const r = res();
  let handler;
  const middlewares = { use: (route, h) => { handler = h; } };
  proxy.configureServer({ middlewares });
  await handler(req("/api/snotel"), r);
  assert.equal(r.statusCode, 200);
  const payload = r.json();
  assert.equal(payload.count, 18);
  assert.equal(payload.stations.length, 18);
  assert.ok(payload.stations.every((s) => s.triplet && s.name), "all stations carry identity");
  assert.equal(payload.summary.total, 18);
});

test("handler: ?station= filters; bad triplet -> 400", async () => {
  clearCaches();
  const proxy = snotelProxy({ fetchImpl: makeFetch({ WTEQ: WTEQ_LIVE, SNWD: SNWD_LIVE }) });
  const r = res();
  let handler;
  const middlewares = { use: (route, h) => { handler = h; } };
  proxy.configureServer({ middlewares });
  await handler(req("/api/snotel?station=302:OR:SNTL"), r);
  assert.equal(r.statusCode, 200);
  const payload = r.json();
  assert.equal(payload.count, 1);
  assert.equal(payload.stations[0].triplet, "302:OR:SNTL");

  const r2 = res();
  await handler(req("/api/snotel?station=bogus!"), r2);
  assert.equal(r2.statusCode, 400);
});

test("handler: both elements down -> honest 502", async () => {
  clearCaches();
  const proxy = snotelProxy({ fetchImpl: makeFetch({}, { failAll: true }) });
  const r = res();
  let handler;
  const middlewares = { use: (route, h) => { handler = h; } };
  proxy.configureServer({ middlewares });
  await handler(req("/api/snotel"), r);
  assert.equal(r.statusCode, 502);
  assert.ok(r.json().error === "snotel_unavailable");
});

test("handler: one element down -> 200 with *_unavailable flags", async () => {
  clearCaches();
  const proxy = snotelProxy({ fetchImpl: makeFetch({ WTEQ: WTEQ_LIVE }) });
  const r = res();
  let handler;
  const middlewares = { use: (route, h) => { handler = h; } };
  proxy.configureServer({ middlewares });
  await handler(req("/api/snotel"), r);
  assert.equal(r.statusCode, 200);
  const payload = r.json();
  // Fixture carries returns for only 3 of the 18 pinned stations; the other
  // 15 are honestly unavailable, and SNWD is entirely missing by design.
  const inFixture = new Set(["908:WA:SNTL", "302:OR:SNTL", "303:CO:SNTL"]);
  assert.ok(payload.stations.every((s) => s.snwdUnavailable === true));
  for (const s of payload.stations) {
    if (inFixture.has(s.triplet)) assert.equal(s.wteqUnavailable, false, s.triplet);
    else assert.equal(s.wteqUnavailable, true, s.triplet);
  }
});
