/**
 * Wave 9 — MIROVA volcano hotspots — ticker model tests (pure).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine } from './model.js';

const DOC = {
  generatedAt: '2026-10-02T12:00:00Z',
  stale: false,
  summary: {
    detections: 3,
    volcanoes: 3,
    byLevel: { moderate: 3 },
    bySensor: { VIIRS: 2, MODIS: 1 },
    maxVrpMw: 67.04,
    maxVrpVolcano: 'Nyamuragira',
  },
  detections: [
    { time: '02-Oct-2026 10:48:02', volcanoId: '223020', name: 'Nyamuragira', vrpMw: 67.04, distanceKm: 1.06, sensor: 'VIIRS', level: 'moderate' },
    { time: '02-Oct-2026 10:50:00', volcanoId: '251020', name: 'Manam', vrpMw: 18.97, distanceKm: 23.19, sensor: 'MODIS', level: 'moderate' },
    { time: '02-Oct-2026 11:00:02', volcanoId: '211040', name: 'Stromboli', vrpMw: 12.11, distanceKm: 1.68, sensor: 'VIIRS', level: 'moderate' },
  ],
};

const QUIET_DOC = {
  generatedAt: '2026-10-02T12:00:00Z',
  stale: false,
  summary: { detections: 0, volcanoes: 0, byLevel: {}, bySensor: {}, maxVrpMw: null, maxVrpVolcano: null },
  detections: [],
};

test('ROUTE/EMOJI/LABEL identity', () => {
  assert.equal(ROUTE, '/api/mirova');
  assert.equal(EMOJI, '🌋');
  assert.equal(LABEL, 'MIROVA volcano hotspots');
});

test('valueLine: count + hottest volcano', () => {
  const line = valueLine(DOC);
  assert.ok(line.includes('🌋'), line);
  assert.ok(line.includes('3 hotspot detections'), line);
  assert.ok(line.includes('Nyamuragira'), line);
  assert.ok(line.includes('67.04 MW'), line);
});

test('valueLine: quiet planet is honest, not blank', () => {
  const line = valueLine(QUIET_DOC);
  assert.ok(line.includes('0 hotspot detections'), line);
});

test('valueLine null on unavailable / unusable payloads', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ error: 'mirova_unavailable' }), null);
  assert.equal(valueLine({ summary: {} }), null);
});

test('detailLine: top volcanoes with verbatim levels', () => {
  const line = detailLine(DOC);
  assert.ok(line.includes('Nyamuragira 67.04 MW (moderate, VIIRS)'), line);
  assert.ok(line.includes('Manam 18.97 MW (moderate, MODIS)'), line);
  assert.ok(line.includes('heat-flux proxy'), line);
});

test('detailLine: quiet document says so explicitly', () => {
  const line = detailLine(QUIET_DOC);
  assert.ok(line.includes('No current MIROVA thermal detections'), line);
});

test('detailLine empty on unavailable', () => {
  assert.equal(detailLine(null), '');
  assert.equal(detailLine({ error: 'mirova_unavailable' }), '');
});
