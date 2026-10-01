/**
 * Wave 9 — HAB ticker model tests (pure, no DOM).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const station = (over = {}) => ({
  id: 'santamonica',
  name: 'Santa Monica Pier',
  ok: true,
  alertLevel: 'present',
  sampleAgeDays: 2.7,
  taxa: {
    Lingulodinium_polyedra: 1870,
    Alexandrium_spp: 0,
    Dinophysis_spp: 0,
    pseudo_nitzschia_combined: 0,
    Akashiwo_sanguinea: 0,
  },
  domoicAcid: { pDA: null, tDA: null, dDA: null, toxinAlert: false },
  ...over,
});

test('ROUTE matches registry', () => {
  assert.equal(ROUTE, '/api/hab');
});

test('valueLine headlines blooms and counts stations', () => {
  const doc = {
    stations: [
      station({ id: 'a', name: 'A', alertLevel: 'bloom' }),
      station({ id: 'b', name: 'B', alertLevel: 'toxin-alert' }),
      station({ id: 'c', name: 'C', alertLevel: 'background' }),
      { id: 'd', name: 'D', ok: false, error: 'no_recent_samples' },
    ],
  };
  const line = valueLine(doc);
  assert.ok(line.includes('HAB 3 CA stations'), line);
  assert.ok(line.includes('1 bloom'), line);
  assert.ok(line.includes('1 toxin alert'), line);
  assert.ok(line.includes('1 dark'), line);
});

test('valueLine returns null with no usable summary', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({}), null);
  assert.equal(valueLine({ stations: [] }), null);
  assert.equal(valueLine({ stations: [{ id: 'x', ok: false }] }), null);
});

test('detailLine renders taxa counts with honesty note', () => {
  const doc = { stations: [station()] };
  const line = detailLine(doc);
  assert.ok(line.includes('Santa Monica Pier'), line);
  assert.ok(line.includes('Lingulodinium 1,870'), line);
  assert.ok(line.includes('10,000 cells/L'), line);
  assert.ok(line.includes('not observed in the latest sample'), line);
});

test('detailLine is empty for null/unavailable payloads', () => {
  assert.equal(detailLine(null), '');
  // {} is not "unavailable" per isUnavailable — it yields the honesty note
  // (same contract as the pollen model: no rows → honesty note only).
  const note = detailLine({});
  assert.ok(note.includes('10,000 cells/L'), note);
  assert.ok(!note.includes('Santa Monica'), note);
});
