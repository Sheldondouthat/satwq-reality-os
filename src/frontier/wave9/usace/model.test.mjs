/**
 * Wave 9 (R2-10) — USACE reservoir ticker model tests (co-located).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine } from './model.js';

const DOC = {
  generatedAt: '2026-10-01T20:00:00.000Z',
  stale: false,
  reservoirs: [
    {
      id: 'ftpk', code: 'FTPK', name: 'Fort Peck Dam & Reservoir', ok: true,
      storage: { acFt: 12475000, ageDays: 0.6, fresh: true },
      poolElevation: { ft: 2222.17, ageDays: 0.1, fresh: true },
    },
    {
      id: 'garr', code: 'GARR', name: 'Garrison Dam & Reservoir', ok: true,
      storage: { acFt: 14030000, ageDays: 0.6, fresh: true },
      poolElevation: { ft: 1838.5, ageDays: 0.2, fresh: true },
    },
    { id: 'bend', code: 'BEND', name: 'Big Bend Dam & Reservoir', ok: false, error: 'x' },
  ],
};

test('ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/usace');
  assert.equal(EMOJI, '🌊');
  assert.equal(LABEL, 'USACE reservoirs');
});

test('valueLine summarizes total storage + biggest reservoir', () => {
  const line = valueLine(DOC);
  assert.ok(line.includes('USACE 2 Missouri reservoirs'), line);
  assert.ok(line.includes('26.5M ac-ft total'), line);
  assert.ok(line.includes('GARR 14M ac-ft'), line);
  assert.ok(line.includes('1 dark'), line);
  assert.ok(line.includes('observed'), line);
});

test('valueLine returns null when nothing usable', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ error: 'usace_unavailable' }), null);
  assert.equal(valueLine({ reservoirs: [] }), null);
  assert.equal(valueLine({ reservoirs: [{ ok: false }] }), null);
});

test('detailLine lists per-reservoir storage + pool elevation', () => {
  const d = detailLine(DOC);
  assert.ok(d.includes('FTPK: 12.5M ac-ft (0.6d ago) · pool 2,222.2 ft (0.1d ago).'), d);
  assert.ok(d.includes('GARR: 14M ac-ft'), d);
  assert.ok(d.includes('no %full'), d); // honesty: capacity never fabricated
  assert.equal(detailLine(null), '');
});
