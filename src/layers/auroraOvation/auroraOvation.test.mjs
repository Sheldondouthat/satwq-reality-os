import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OVATION_GRID_LONS,
  OVATION_GRID_LATS,
  OVATION_RAMP_MAX,
  parseOvationGrid,
  ovationRgba,
  angularDistanceDeg,
  isNight,
  ovationImageBuffer,
  ovationLegendStops,
} from './model.js';
import { createOvationSource, OVATION_URL } from './source.js';

/** Small inline fixture mirroring the real SWPC payload shape. */
function fixturePayload() {
  return {
    'Observation Time': '2026-09-27T03:34:00Z',
    'Forecast Time': '2026-09-27T04:35:00Z',
    'Data Format': '[Longitude, Latitude, Aurora]',
    type: 'FeatureCollection',
    coordinates: [
      [0, -90, 3],
      [359, 90, 0],
      [180, 65, 25], // strong aurora, northern oval
      [181, -65, 12], // southern oval
      [90, 0, 0], // equator, none
      ['bad', 0, 5], // skipped: non-numeric
      [400, 0, 9], // skipped: out of range
    ],
  };
}

describe('auroraOvation model: OVATION grid parsing', () => {
  it('parses the real payload shape into a 360x181 grid', () => {
    const grid = parseOvationGrid(fixturePayload());
    assert.equal(grid.observationTimeMs, Date.parse('2026-09-27T03:34:00Z'));
    assert.equal(grid.forecastTimeMs, Date.parse('2026-09-27T04:35:00Z'));
    assert.equal(grid.count, 5); // 2 invalid rows skipped
    assert.equal(grid.values.length, OVATION_GRID_LONS * OVATION_GRID_LATS);
    // lon 180 / lat 65 -> lonIdx 180, latIdx 155
    assert.equal(grid.values[155 * 360 + 180], 25);
    assert.equal(grid.values[180 * 360 + 359], 0); // lat 90
  });

  it('throws on malformed payloads instead of faking data', () => {
    assert.throws(() => parseOvationGrid(null), /Malformed OVATION/);
    assert.throws(() => parseOvationGrid({}), /Malformed OVATION/);
    assert.throws(
      () => parseOvationGrid({ coordinates: [], 'Observation Time': 'junk' }),
      /Malformed OVATION/,
    );
    assert.throws(
      () =>
        parseOvationGrid({
          'Observation Time': '2026-09-27T03:34:00Z',
          coordinates: [['x', 'y', 'z']],
        }),
      /no valid grid cells/,
    );
  });
});

describe('auroraOvation model: color ramp and night mask', () => {
  it('maps 0 to transparent and ramps green->yellow->red', () => {
    assert.deepEqual(ovationRgba(0), [0, 0, 0, 0]);
    assert.deepEqual(ovationRgba(-3), [0, 0, 0, 0]);
    const low = ovationRgba(2); // greenish
    assert.ok(low[1] > low[0] && low[1] > low[2], `low=${low}`);
    const high = ovationRgba(OVATION_RAMP_MAX); // saturated red
    assert.deepEqual(high.slice(0, 3), [255, 42, 42]);
    assert.equal(high[3], 255);
    const mid = ovationRgba(12); // yellow-orange band
    assert.ok(mid[0] > 200 && mid[1] > 150);
    // alpha grows with intensity
    assert.ok(ovationRgba(2)[3] < ovationRgba(20)[3]);
  });

  it('computes great-circle distance and the night test', () => {
    assert.ok(Math.abs(angularDistanceDeg(0, 0, 0, 0)) < 1e-9);
    assert.ok(Math.abs(angularDistanceDeg(0, 0, 180, 0) - 180) < 1e-9);
    assert.ok(Math.abs(angularDistanceDeg(0, 0, 90, 0) - 90) < 1e-9);
    // subsolar point at (0,0): antipode is night, subsolar is day
    assert.equal(isNight(180, 0, 0, 0), true);
    assert.equal(isNight(0, 0, 0, 0), false);
    // inside the 6° twilight margin counts as day
    assert.equal(isNight(93, 0, 0, 0), false);
    assert.equal(isNight(100, 0, 0, 0), true);
  });

  it('builds a canvas-order RGBA buffer with night masking', () => {
    const grid = parseOvationGrid(fixturePayload());
    // subsolar at lon 0/lat 0: fixture aurora at lon 180 is deep night.
    const buf = ovationImageBuffer(grid, { subLon: 0, subLat: 0 });
    assert.equal(buf.width, 360);
    assert.equal(buf.height, 181);
    assert.equal(buf.data.length, 360 * 181 * 4);
    // fixture cell (lon 180, lat 65, value 25): canvas x = 180+180=360 mod 360 = 0? no:
    // geographic lon 180 -> canvasX = 180+180 = 360 -> (180+180)%360 = 0. lat 65 -> y = 90-65 = 25.
    const o = (25 * 360 + 0) * 4;
    assert.ok(buf.data[o + 3] > 200, `night alpha=${buf.data[o + 3]}`); // full night intensity
    assert.deepEqual([buf.data[o], buf.data[o + 1], buf.data[o + 2]], ovationRgba(25).slice(0, 3));
    // equator noon cell (lon 90, value 0): transparent regardless
    const oEq = ((90 - 0) * 360 + (90 + 180)) * 4;
    assert.equal(buf.data[oEq + 3], 0);
  });

  it('dims the day side instead of deleting it', () => {
    const grid = parseOvationGrid({
      'Observation Time': '2026-09-27T03:34:00Z',
      coordinates: [[10, 0, 20]], // near subsolar noon
    });
    const buf = ovationImageBuffer(grid, { subLon: 0, subLat: 0, dayDim: 0.08 });
    const x = 10 + 180;
    const y = 90 - 0;
    const o = (y * 360 + x) * 4;
    const full = ovationRgba(20)[3];
    assert.equal(buf.data[o + 3], Math.round(full * 0.08));
  });

  it('emits legend stops with CSS colors', () => {
    const stops = ovationLegendStops();
    assert.equal(stops.length, 5);
    assert.equal(stops[stops.length - 1].label, `${OVATION_RAMP_MAX}+`);
    assert.match(stops[0].css, /^rgba\(\d+,\d+,\d+,0\.\d+\)$/);
  });
});

describe('auroraOvation source', () => {
  it('fetches the SWPC OVATION endpoint and returns the parsed grid', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      return { ok: true, json: async () => fixturePayload() };
    };
    const source = createOvationSource({ fetchImpl });
    const grid = await source.getSnapshot({});
    assert.equal(seen[0], OVATION_URL);
    assert.equal(grid.count, 5);
  });

  it('throws on HTTP errors and malformed JSON', async () => {
    const bad = createOvationSource({
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    await assert.rejects(() => bad.getSnapshot({}), /SWPC OVATION HTTP 503/);
    const malformed = createOvationSource({
      fetchImpl: async () => ({ ok: true, json: async () => ({ nope: true }) }),
    });
    await assert.rejects(() => malformed.getSnapshot({}), /Malformed OVATION/);
  });
});
