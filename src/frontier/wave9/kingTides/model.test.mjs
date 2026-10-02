import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine } from './model.js';

const DOC = {
  generatedAt: '2026-10-02T00:00:00.000Z',
  route: '/api/king-tides',
  year: 2026,
  top: 5,
  count: 1,
  okCount: 1,
  units: 'feet MLLW',
  stations: [
    {
      station: { id: '8638610', name: 'Sewells Point', lat: 36.9428, lon: -76.3286 },
      ok: true,
      year: 2026,
      top: 5,
      predictionCount: 1410,
      yearMaxFeet: 3.456,
      kingTides: [
        {
          rank: 1, kingTide: true, time: '2026-11-06T04:12:00.000Z', feet: 3.456,
          moonPhase: 'Full Moon', elongationDeg: 178.2, illumination: 0.999,
          waxing: false, nearNewMoon: false, nearFullMoon: true,
          springWindow: true, moonDistanceKm: 364120, perigean: true,
        },
        {
          rank: 2, kingTide: true, time: '2026-10-07T03:48:00.000Z', feet: 3.444,
          moonPhase: 'Full Moon', elongationDeg: 171.5, illumination: 0.997,
          waxing: false, nearNewMoon: false, nearFullMoon: true,
          springWindow: true, moonDistanceKm: 372736, perigean: false,
        },
      ],
      monthlyMaxima: [],
    },
  ],
};

test('route/emoji/label constants', () => {
  assert.equal(ROUTE, '/api/king-tides');
  assert.equal(typeof EMOJI, 'string');
  assert.equal(LABEL, 'King-tide calendar');
});

test('valueLine names the top king tide with lunar context', () => {
  const line = valueLine(DOC);
  assert.ok(line.includes('3.456'), line);
  assert.ok(line.includes('2026-11-06'), line);
  assert.ok(line.includes('perigean'), line);
  assert.ok(line.includes('2026'), line);
});

test('valueLine returns null when unusable', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({}), null);
  assert.equal(valueLine({ stations: [] }), null);
});

test('detailLine lists top-3 with phase flags and the honesty note', () => {
  const line = detailLine(DOC);
  assert.ok(line.includes('#1'), line);
  assert.ok(line.includes('Full Moon'), line);
  assert.ok(line.includes('Predicted highs (NOAA model), not observed levels'), line);
});

test('detailLine degrades honestly on empty payloads', () => {
  const line = detailLine({ stations: [] });
  assert.ok(line.includes('quiet seas'), line);
});
