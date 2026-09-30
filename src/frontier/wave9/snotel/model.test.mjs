/**
 * snotel model.test.mjs — SNOTEL ticker model tests.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ROUTE, LABEL, valueLine, detailLine } from "./model.js";

test("ROUTE/LABEL pin", () => {
  assert.equal(ROUTE, "/api/snotel");
  assert.equal(LABEL, "SNOTEL snowpack");
});

const DOC = {
  summary: { total: 18, withData: 18, withSnow: 4, maxSnwdIn: 2, maxSnwdStation: "Apishapa, CO" },
  stations: [
    { name: "Apishapa", state: "CO", hasSnow: true, snwdIn: 2 },
    { name: "Aneroid Lake #2", state: "OR", hasSnow: true, snwdIn: 1 },
    { name: "Alta Lakes", state: "CO", hasSnow: true, snwdIn: 0 },
    { name: "Alpine Meadows", state: "WA", hasSnow: false, snwdIn: 0 },
  ],
};

test("valueLine: counts + max station", () => {
  const line = valueLine(DOC);
  assert.ok(line.includes("SNOTEL 4/18 stations w/ snow"), line);
  assert.ok(line.includes("max 2in Apishapa, CO"), line);
});

test("valueLine: zero snow reads honest, not null", () => {
  const line = valueLine({ ...DOC, summary: { ...DOC.summary, withSnow: 0 } });
  assert.ok(line.includes("SNOTEL 0/18 stations w/ snow"), line);
});

test("valueLine: unavailable -> null", () => {
  assert.equal(valueLine({ error: "snotel_unavailable" }), null);
  assert.equal(valueLine(null), null);
});

test("detailLine: deepest-three + honesty note", () => {
  const line = detailLine(DOC);
  assert.ok(line.includes("Apishapa, CO 2in"), line);
  assert.ok(line.includes("0 = sensor reported no snow"), line);
});
