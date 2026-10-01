/**
 * Wave 9 — NASA Exoplanet Archive catalog — ticker model tests.
 *
 * Fixtures mirror the real 2026-09-30 TAP payload shape
 * (count 6,372; TOI-707 b newest, 2026).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROUTE, valueLine, detailLine } from "./model.js";

const DOC = {
  generatedAt: "2026-09-30T23:00:00.000Z",
  stale: false,
  confirmedPlanets: 6372,
  shown: 2,
  requested: 15,
  maxDiscYear: 2026,
  latest: [
    { name: "TOI-707 b", host: "TOI-707", discYear: 2026, distPc: 130.96, orbPeriodDays: 52.7992, radiusEarth: 2.3983, massEarth: null },
    { name: "KMT-2021-BLG-1898L b", host: "KMT-2021-BLG-1898L", discYear: 2022, distPc: 6900, orbPeriodDays: null, radiusEarth: null, massEarth: 251.0844 },
  ],
};

describe("exoplanets model", () => {
  it("ROUTE matches the registry route", () => {
    assert.equal(ROUTE, "/api/exoplanets");
  });

  it("valueLine carries the confirmed count and newest planet", () => {
    const line = valueLine(DOC);
    assert.ok(line.includes("6,372"), line);
    assert.ok(line.includes("TOI-707 b"), line);
    assert.ok(line.includes("2026"), line);
  });

  it("valueLine returns null without a usable count", () => {
    assert.equal(valueLine({}), null);
    assert.equal(valueLine({ confirmedPlanets: null, latest: [] }), null);
  });

  it("valueLine degrades gracefully with no latest rows", () => {
    const line = valueLine({ confirmedPlanets: 6372, latest: [] });
    assert.ok(line.includes("6,372"), line);
    assert.ok(!line.includes("newest"), line);
  });

  it("valueLine tags stale payloads", () => {
    const line = valueLine({ ...DOC, stale: true });
    assert.ok(line.includes("stale"), line);
  });

  it("detailLine lists newest planets and states the honesty notes", () => {
    const d = detailLine(DOC);
    assert.ok(d.includes("6,372 confirmed"), d);
    assert.ok(d.includes("TOI-707 b"), d);
    assert.ok(d.includes("52.7992d"), d);
    assert.ok(d.includes("candidates excluded"), d);
    assert.ok(d.includes("never measured"), d);
  });

  it("detailLine is empty on unavailable docs", () => {
    assert.equal(detailLine(null), "");
    assert.equal(detailLine({ error: "exoplanets_unavailable" }), "");
  });
});
