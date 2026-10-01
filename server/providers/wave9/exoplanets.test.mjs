/**
 * Wave 9 (R2-7) — NASA Exoplanet Archive provider tests.
 *
 * Fixtures are real 2026-09-30 TAP capture bytes (keyless, verified live):
 *   count → [{"n": 6372}]  (COUNT(DISTINCT pl_name) over ps)
 *   latest → 5 rows, pl_name/hostname/disc_year/sy_dist/pl_orbper/pl_rade/pl_bmasse
 * (copy: goals/finish-all-my-work/hidden_files/probes-2026-09-30-1942/tap-*.body)
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseTapCount,
  parseTapLatest,
  buildExoplanetsPayload,
  exoplanetsProxy,
  clearExoplanetsCaches,
} from "./exoplanets.js";

const COUNT_FIXTURE = JSON.stringify([{ n: 6372 }]);

// Real 2026-09-30 live bytes (tap-where.body).
const LATEST_FIXTURE = JSON.stringify([
  { pl_name: "TOI-707 b", hostname: "TOI-707", disc_year: 2026, sy_dist: 130.959, pl_orbper: 52.79920330011, pl_rade: 2.39827136, pl_bmasse: null },
  { pl_name: "KMT-2021-BLG-1898L b", hostname: "KMT-2021-BLG-1898L", disc_year: 2022, sy_dist: 6900.0, pl_orbper: null, pl_rade: null, pl_bmasse: 251.08444153 },
  { pl_name: "Kepler-1513 b", hostname: "Kepler-1513", disc_year: 2016, sy_dist: 349.247, pl_orbper: 160.8842, pl_rade: 8.594, pl_bmasse: 48.30991786 },
  { pl_name: "HAT-P-45 b", hostname: "HAT-P-45", disc_year: 2014, sy_dist: 298.64, pl_orbper: 3.12899506, pl_rade: null, pl_bmasse: null },
  { pl_name: "Kepler-317 c", hostname: "Kepler-317", disc_year: 2014, sy_dist: 940.584, pl_orbper: 8.775, pl_rade: null, pl_bmasse: null },
]);

const VOTABLE_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<VOTABLE version="1.4"><RESOURCE type="results">
<INFO name="QUERY_STATUS" value="ERROR">ORA-00904: 'DISC_METHOD': invalid identifier</INFO>
</RESOURCE></VOTABLE>`;

describe("parseTapCount", () => {
  it("parses the real count fixture", () => {
    assert.equal(parseTapCount(COUNT_FIXTURE), 6372);
  });

  it("rejects VOTABLE error pages as 502, never as data", () => {
    assert.throws(() => parseTapCount(VOTABLE_ERROR), (e) => e.status === 502);
  });

  it("rejects non-array and multi-row shapes", () => {
    assert.throws(() => parseTapCount(JSON.stringify({ n: 1 })), (e) => e.status === 502);
    assert.throws(() => parseTapCount(JSON.stringify([])), (e) => e.status === 502);
    assert.throws(() => parseTapCount(JSON.stringify([{ n: 1 }, { n: 2 }])), (e) => e.status === 502);
  });

  it("rejects non-integer / negative counts", () => {
    assert.throws(() => parseTapCount(JSON.stringify([{ n: -3 }])), (e) => e.status === 502);
    assert.throws(() => parseTapCount(JSON.stringify([{ n: 1.5 }])), (e) => e.status === 502);
    assert.throws(() => parseTapCount(JSON.stringify([{ n: null }])), (e) => e.status === 502);
  });
});

describe("parseTapLatest", () => {
  it("parses the real latest fixture with nulls preserved", () => {
    const rows = parseTapLatest(LATEST_FIXTURE);
    assert.equal(rows.length, 5);
    assert.equal(rows[0].name, "TOI-707 b");
    assert.equal(rows[0].host, "TOI-707");
    assert.equal(rows[0].discYear, 2026);
    assert.equal(rows[0].distPc, 130.96);
    assert.equal(rows[0].orbPeriodDays, 52.7992);
    assert.equal(rows[0].radiusEarth, 2.3983);
    assert.equal(rows[0].massEarth, null); // unmeasured — never zero-filled
    assert.equal(rows[1].orbPeriodDays, null);
    assert.equal(rows[1].massEarth, 251.0844);
  });

  it("Number('')===0 trap: empty-string numerics become null, never 0", () => {
    const rows = parseTapLatest(
      JSON.stringify([{ pl_name: "X b", hostname: "X", disc_year: "", sy_dist: "", pl_orbper: "", pl_rade: "", pl_bmasse: "" }]),
    );
    assert.equal(rows[0].discYear, null);
    assert.equal(rows[0].distPc, null);
    assert.equal(rows[0].orbPeriodDays, null);
  });

  it("rejects VOTABLE error pages as 502", () => {
    assert.throws(() => parseTapLatest(VOTABLE_ERROR), (e) => e.status === 502);
  });

  it("rejects non-array bodies", () => {
    assert.throws(() => parseTapLatest(JSON.stringify({ rows: [] })), (e) => e.status === 502);
  });
});

describe("buildExoplanetsPayload", () => {
  const parsed = { confirmedPlanets: 6372, latest: parseTapLatest(LATEST_FIXTURE) };

  it("builds the published payload with honesty block", () => {
    const p = buildExoplanetsPayload(parsed, { nowMs: 0, query: { n: 15 } });
    assert.equal(p.confirmedPlanets, 6372);
    assert.equal(p.shown, 5);
    assert.equal(p.maxDiscYear, 2026);
    assert.equal(p.stale, false);
    assert.equal(p.latest[0].name, "TOI-707 b");
    assert.ok(p.honesty.confirmedOnly.includes("candidates are excluded"));
    assert.ok(p.honesty.countSemantics.includes("DISTINCT"));
    assert.ok(p.honesty.nulls.includes("never zero-filled"));
  });

  it("drops unnamed rows; throws 502 when nothing nameable remains", () => {
    const named = buildExoplanetsPayload(
      { confirmedPlanets: 10, latest: [{ name: "A b", host: "A", discYear: 2020, distPc: 1, orbPeriodDays: 1, radiusEarth: 1, massEarth: 1 }, { name: null, host: null, discYear: null, distPc: null, orbPeriodDays: null, radiusEarth: null, massEarth: null }] },
      { nowMs: 0, query: { n: 2 } },
    );
    assert.equal(named.shown, 1);
    assert.throws(
      () => buildExoplanetsPayload({ confirmedPlanets: 10, latest: [{ name: null }] }, { nowMs: 0, query: { n: 1 } }),
      (e) => e.status === 502,
    );
  });
});

describe("exoplanetsProxy", () => {
  beforeEach(() => clearExoplanetsCaches());

  function fakeRes() {
    const res = {
      status: null,
      headers: null,
      body: null,
      writeHead(s, h) { res.status = s; res.headers = h; },
      end(b) { res.body = b; },
      once() {},
      removeListener() {},
    };
    return res;
  }

  function fakeReq(url, method = "GET") {
    return { method, url, once() {}, removeListener() {}, headers: {} };
  }

  function mount(provider) {
    const calls = [];
    provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
    return calls;
  }

  /** Fake fetch returning JSON text with a headers.get stub (readResponseTextCapped path). */
  function okFetchFor({ count = COUNT_FIXTURE, latest = LATEST_FIXTURE, calls = null } = {}) {
    return async (url) => {
      calls?.push(String(url));
      const isCount = String(url).includes("count");
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => (isCount ? count : latest),
        body: null,
      };
    };
  }

  it("mounts at /api/exoplanets", () => {
    const [{ route }] = mount(exoplanetsProxy({ fetchImpl: okFetchFor(), now: () => 0 }));
    assert.equal(route, "/api/exoplanets");
  });

  it("serves 200 with the live shape on happy path", async () => {
    const [{ handler }] = mount(exoplanetsProxy({ fetchImpl: okFetchFor(), now: () => 0 }));
    const res = fakeRes();
    await handler(fakeReq("/api/exoplanets?n=5"), res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.confirmedPlanets, 6372);
    assert.equal(body.shown, 5);
    assert.equal(body.latest[0].name, "TOI-707 b");
    assert.equal(body.stale, false);
    assert.ok(body.honesty.confirmedOnly.includes("candidates are excluded"));
  });

  it("queries TAP with the validated n bound", async () => {
    const calls = [];
    const [{ handler }] = mount(exoplanetsProxy({ fetchImpl: okFetchFor({ calls }), now: () => 0 }));
    const res = fakeRes();
    await handler(fakeReq("/api/exoplanets?n=3"), res);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
    assert.ok(/top[+ ]3/i.test(calls[1]), calls[1]);
  });

  it("400s on out-of-range n", async () => {
    for (const url of ["/api/exoplanets?n=0", "/api/exoplanets?n=51", "/api/exoplanets?n=abc"]) {
      const [{ handler }] = mount(exoplanetsProxy({ fetchImpl: okFetchFor(), now: () => 0 }));
      const res = fakeRes();
      await handler(fakeReq(url), res);
      assert.equal(res.status, 400, url);
    }
  });

  it("maps upstream 500 and AbortError to honest 502", async () => {
    const fail500 = async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "", body: null });
    const abort = async () => { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; };
    for (const [label, fetchImpl] of [["500", fail500], ["abort", abort]]) {
      const [{ handler }] = mount(exoplanetsProxy({ fetchImpl, now: () => 0 }));
      const res = fakeRes();
      await handler(fakeReq("/api/exoplanets"), res);
      assert.equal(res.status, 502, label);
      assert.equal(JSON.parse(res.body).error, "exoplanets_unavailable");
    }
  });

  it("serves key-scoped stale payload after an upstream failure", async () => {
    const p1 = exoplanetsProxy({ fetchImpl: okFetchFor(), now: () => 0 });
    const res1 = fakeRes();
    await mount(p1)[0].handler(fakeReq("/api/exoplanets?n=5"), res1);
    assert.equal(res1.status, 200);

    const fail = async () => { throw new Error("fetch failed"); };
    // 25h later: docCache TTL (24h) expired so the fetch is attempted and
    // fails, but the payloadCache stale window (14d) still holds the payload.
    const p2 = exoplanetsProxy({ fetchImpl: fail, now: () => 90_000_000 });
    const res2 = fakeRes();
    await mount(p2)[0].handler(fakeReq("/api/exoplanets?n=5"), res2);
    assert.equal(res2.status, 200);
    const body = JSON.parse(res2.body);
    assert.equal(body.stale, true);
    assert.equal(body.confirmedPlanets, 6372);
  });

  it("405s non-GET", async () => {
    const [{ handler }] = mount(exoplanetsProxy({ fetchImpl: okFetchFor(), now: () => 0 }));
    const res = fakeRes();
    await handler(fakeReq("/api/exoplanets", "POST"), res);
    assert.equal(res.status, 405);
  });
});
