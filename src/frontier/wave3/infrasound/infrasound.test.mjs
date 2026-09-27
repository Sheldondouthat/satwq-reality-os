import assert from 'node:assert/strict';
import test from 'node:test';
import { audifyEnvelope, envelopeSparkline, fmtPa } from './model.js';

test('fmtPa formats Pascals and marks unknown as —', () => {
  assert.equal(fmtPa(4.09394), '4.094 Pa');
  assert.equal(fmtPa(15.732, 1), '15.7 Pa');
  assert.equal(fmtPa(null), '—');
  assert.equal(fmtPa(NaN), '—');
});

test('envelopeSparkline renders an SVG polyline', () => {
  const svg = envelopeSparkline([0, 1, 0.5, 0.25], '#ff5a5a');
  assert.ok(svg.includes('<svg'), 'has svg element');
  assert.ok(svg.includes('<polyline'), 'has polyline');
  assert.ok(svg.includes('#ff5a5a'), 'uses the pressure color');
  // 4 points → 4 coordinate pairs
  const pts = svg.match(/points="([^"]+)"/)[1].trim().split(' ');
  assert.equal(pts.length, 4);
});

test('envelopeSparkline returns empty string for no data', () => {
  assert.equal(envelopeSparkline([], '#fff'), '');
  assert.equal(envelopeSparkline(null, '#fff'), '');
});

test('audifyEnvelope refuses without data and outside browsers', () => {
  assert.equal(audifyEnvelope([]), false);
  assert.equal(audifyEnvelope(null), false);
  // node has no window → must fail closed, never throw
  assert.equal(audifyEnvelope([0.1, 0.5, 1.0]), false);
});
