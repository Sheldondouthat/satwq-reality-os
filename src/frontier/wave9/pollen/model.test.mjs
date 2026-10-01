/**
 * Wave 9 (R2-8) — pollen ticker model tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine } from './model.js';

const DOC = {
  units: 'grains/m³',
  locations: [
    {
      id: 'berlin', name: 'Berlin', ok: true, coverage: 'cams-europe',
      current: { alder: 0, birch: 0, grass: 0.1, mugwort: 0.1, olive: 0, ragweed: 0.5 },
    },
    {
      id: 'paris', name: 'Paris', ok: true, coverage: 'cams-europe',
      current: { alder: 0, birch: 0, grass: 0.2, mugwort: 0, olive: 0.1, ragweed: 0.1 },
    },
    { id: 'pt-x', name: 'Custom point', ok: false, error: 'pollen_upstream_500' },
  ],
};

test('model constants', () => {
  assert.equal(ROUTE, '/api/pollen');
  assert.equal(EMOJI, '🌾');
  assert.ok(LABEL.includes('CAMS'));
});

test('valueLine headlines the highest current reading', () => {
  const line = valueLine(DOC);
  assert.ok(line.includes('🌾 Pollen 2 EU cities')); // ok:false row excluded
  assert.ok(line.includes('ragweed 0.5'));
  assert.ok(line.includes('(Berlin)'));
  assert.ok(line.includes('CAMS model'));
});

test('valueLine returns null with no usable summary', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ error: 'pollen_unavailable' }), null);
  assert.equal(valueLine({ locations: [] }), null);
  assert.equal(valueLine({ locations: [{ ok: false }] }), null);
});

test('detailLine lists per-city readings honestly', () => {
  const d = detailLine(DOC);
  assert.ok(d.includes('Berlin:'));
  assert.ok(d.includes('ragweed 0.5'));
  assert.ok(d.includes('grains/m³'));
  assert.ok(d.includes('simulation, not sensor observations'));
  assert.equal(detailLine(null), '');
});
