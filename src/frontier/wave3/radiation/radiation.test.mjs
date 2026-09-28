/**
 * Radiation map model tests (wave3 sci-fi B #4) — added at integration time;
 * the feature shipped without a test file. Pure helpers only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  doseBand,
  validateRadiationPayload,
  DOSE_BANDS,
  BAND_COLORS,
  BAND_LABELS,
  stationsToPoints,
} from './model.js';

describe('doseBand', () => {
  it('maps sub-background values to low', () => {
    assert.equal(doseBand(0.05), 'low');
    assert.equal(doseBand(0.099), 'low');
  });
  it('maps typical background range', () => {
    assert.equal(doseBand(0.1), 'background');
    assert.equal(doseBand(0.25), 'background');
  });
  it('maps elevated and high bands', () => {
    assert.equal(doseBand(0.5), 'elevated');
    assert.equal(doseBand(1.0), 'high');
    assert.equal(doseBand(12.4), 'high');
  });
  it('maps non-finite input to unknown', () => {
    assert.equal(doseBand(NaN), 'unknown');
    assert.equal(doseBand(null), 'unknown');
    assert.equal(doseBand(undefined), 'unknown');
    assert.equal(doseBand(Infinity), 'unknown');
  });
  it('exposes a color and label for every band', () => {
    for (const band of DOSE_BANDS) {
      assert.ok(BAND_COLORS[band], `color for ${band}`);
      assert.ok(BAND_LABELS[band], `label for ${band}`);
    }
  });
});

describe('validateRadiationPayload', () => {
  it('rejects non-objects', () => {
    assert.equal(validateRadiationPayload(null).ok, false);
    assert.equal(validateRadiationPayload('x').ok, false);
  });
  it('rejects missing points array', () => {
    assert.equal(validateRadiationPayload({}).ok, false);
  });
  it('accepts a well-formed payload', () => {
    const r = validateRadiationPayload({
      points: [{ lat: 35.7, lon: 139.7, valueUsvH: 0.12 }],
    });
    assert.equal(r.ok, true);
  });
  it('rejects points with bad coordinates', () => {
    const r = validateRadiationPayload({
      points: [{ lat: 999, lon: 0, valueUsvH: 0.1 }],
    });
    assert.equal(r.ok, false);
  });
});

describe('stationsToPoints (wave6 adapter)', () => {
  it('maps wave6 stations to dose points', () => {
    const out = stationsToPoints({
      generatedAt: '2026-09-28T00:00:00Z',
      stations: [
        { id: 'a', lat: 40.1, lon: -80.2, usvPerHour: 0.12, time: '2026-09-27T23:00:00Z' },
        { id: 'b', lat: 41, lon: -81, cpm: 30 }, // CPM-only: skipped, never faked
        { id: 'c', lat: null, lon: -81, usvPerHour: 0.1 }, // bad coord: skipped
      ],
    });
    assert.equal(out.points.length, 1);
    assert.deepEqual(out.points[0], {
      lat: 40.1, lon: -80.2, valueUsvH: 0.12, unit: '\u00b5Sv/h',
      capturedAt: '2026-09-27T23:00:00Z',
    });
    assert.equal(out.generatedAt, '2026-09-28T00:00:00Z');
  });
  it('passes legacy {points} through untouched', () => {
    const pts = [{ lat: 1, lon: 2, valueUsvH: 0.1 }];
    assert.equal(stationsToPoints({ points: pts }).points, pts);
  });
  it('returns empty points for non-objects', () => {
    assert.deepEqual(stationsToPoints(null).points, []);
    assert.deepEqual(stationsToPoints({ stations: null }).points, []);
  });
});
