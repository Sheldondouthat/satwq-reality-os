import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine, stationCount } from './model.js';

const DOC = {
  generatedAt: '2026-10-03T00:00:00.000Z',
  route: '/api/storm-surge',
  days: 2,
  count: 1,
  okCount: 1,
  units: 'feet MLLW',
  stations: [
    {
      station: { id: '8638610', name: 'Sewells Point', lat: 36.9428, lon: -76.3286 },
      ok: true,
      window: { days: 2, from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T23:00:00.000Z' },
      predictionHours: 72,
      residuals: [],
      summary: {
        matchedHours: 57,
        maxResidualFeet: 0.556,
        maxResidualTime: '2026-10-01T05:00:00.000Z',
        minResidualFeet: -0.045,
        minResidualTime: '2026-10-02T23:00:00.000Z',
        meanResidualFeet: 0.258,
        latestResidualFeet: 0.447,
        latestResidualTime: '2026-10-03T08:00:00.000Z',
      },
    },
  ],
};

test('route/emoji/label constants', () => {
  assert.equal(ROUTE, '/api/storm-surge');
  assert.equal(typeof EMOJI, 'string');
  assert.equal(LABEL, 'Storm-surge residuals');
});

test('valueLine names the max residual with direction and station', () => {
  const line = valueLine(DOC);
  assert.ok(line.includes('+0.556'), line);
  assert.ok(line.includes('above'), line);
  assert.ok(line.includes('Sewells Point'), line);
});

test('valueLine returns null when unusable', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({}), null);
  assert.equal(valueLine({ stations: [] }), null);
  assert.equal(valueLine({ stations: [{ ok: false }] }), null);
});

test('detailLine lists max/latest/mean with the honesty note', () => {
  const line = detailLine(DOC);
  assert.ok(line.includes('+0.556'), line);
  assert.ok(line.includes('2026-10-01'), line);
  assert.ok(line.includes('+0.447'), line);
  assert.ok(line.includes('57h'), line);
  assert.ok(line.includes('not a forecast'), line);
});

test('detailLine degrades honestly on empty payload', () => {
  const line = detailLine({});
  assert.ok(line.includes('not a zero') || line.includes('gap'), line);
});

test('stationCount picks okCount', () => {
  assert.equal(stationCount(DOC), 1);
  assert.equal(stationCount({}), null);
});
