/**
 * Wave 9 — sea-ice ticker model tests (synthetic doc, pure model).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { valueLine, detailLine, ROUTE } from './model.js';

const DOC = {
  generatedAt: '2026-10-03T12:00:00.000Z',
  stale: false,
  hemispheres: [
    {
      hemi: 'north', ok: true,
      latest: { date: '2026-10-02', extentMkm2: 5.713, missingMkm2: 0 },
      dayOfYear: { month: 10, day: 2, recordMeanMkm2: 5.502, recordN: 48, anomalyMkm2: 0.211, recordMin: { value: 4.6, date: '2007-10-02' }, recordMax: { value: 7.1, date: '1985-10-02' } },
    },
    {
      hemi: 'south', ok: true,
      latest: { date: '2026-10-02', extentMkm2: 16.65, missingMkm2: 0 },
      dayOfYear: { month: 10, day: 2, recordMeanMkm2: 17.072, recordN: 48, anomalyMkm2: -0.422, recordMin: { value: 16.65, date: '2026-10-02' }, recordMax: { value: 19.0, date: '1980-10-02' } },
    },
  ],
};

test('route is the sea-ice endpoint', () => {
  assert.equal(ROUTE, '/api/sea-ice');
});

test('valueLine names both hemispheres with extent and anomaly', () => {
  const line = valueLine(DOC);
  assert.match(line, /Arctic 5\.71M km²/);
  assert.match(line, /Antarctic 16\.65M km²/);
  assert.match(line, /\+0\.21 vs record avg/);
  assert.match(line, /-0\.42 vs record avg/);
});

test('valueLine returns null on unavailable payloads', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ error: 'seaice_unavailable' }), null);
  assert.equal(valueLine({ hemispheres: [] }), null);
  assert.equal(valueLine({}), null);
});

test('valueLine degrades with partial hemispheres', () => {
  const line = valueLine({ hemispheres: [DOC.hemispheres[0]] });
  assert.match(line, /Arctic/);
  assert.doesNotMatch(line, /Antarctic/);
});

test('detailLine carries record context and honesty', () => {
  const d = detailLine(DOC);
  assert.match(d, /Arctic: 5\.71M km² on 2026-10-02/);
  assert.match(d, /n=48/);
  assert.match(d, /not thickness/);
  assert.match(d, /not the 1981-2010 baseline/);
});

test('detailLine returns empty string on unavailable', () => {
  assert.equal(detailLine(null), '');
});
