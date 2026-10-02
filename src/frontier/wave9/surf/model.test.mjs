/**
 * Wave 9 — surf & sea state — ticker model tests (pure).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine, toFt, M_TO_FT } from './model.js';

const DOC = {
  generatedAt: '2026-10-02T15:45:00Z',
  stale: false,
  summary: { total: 8, ok: 8, dark: 0, maxWaveHeightM: 1.524, maxWaveSpotId: 'pipeline' },
  spots: [
    { id: 'pipeline', name: 'Pipeline, Oahu HI', ok: true, latest: { waveHeightM: 0.3048, wavePeriodS: 11 } },
    { id: 'trestles', name: 'Trestles, San Clemente CA', ok: true, latest: { waveHeightM: 0, wavePeriodS: 9 } },
  ],
};

test('ROUTE matches the registry', () => {
  assert.equal(ROUTE, '/api/surf');
});

test('toFt converts meters to feet', () => {
  assert.ok(Math.abs(toFt(0.3048) - 1.0) < 0.001);
  assert.equal(toFt(null), null);
  assert.equal(M_TO_FT, 3.28084);
});

test('valueLine names the max spot and says forecast', () => {
  const line = valueLine(DOC);
  assert.ok(line.includes('5.0 ft'), `line: ${line}`);
  assert.ok(line.includes('Pipeline, Oahu HI'), `line: ${line}`);
  assert.ok(line.includes('forecast'), `line: ${line}`);
  assert.ok(line.includes('8/8'), `line: ${line}`);
});

test('valueLine returns null when the summary is unusable', () => {
  assert.equal(valueLine({ summary: {} }), null);
  assert.equal(valueLine(null), null);
});

test('detailLine lists spots and carries the model disclaimer', () => {
  const line = detailLine(DOC);
  assert.ok(line.includes('Pipeline, Oahu HI: 1.0 ft / 11 s'), `line: ${line}`);
  assert.ok(line.includes('Trestles, San Clemente CA: 0.0 ft / 9 s'), `line: ${line}`);
  assert.ok(line.includes('not buoy observations'), `line: ${line}`);
});

test('detailLine stays silent-safe on empty payloads', () => {
  assert.equal(detailLine(null), '');
  assert.ok(detailLine({ spots: [] }).includes('No surf forecast data'));
});
