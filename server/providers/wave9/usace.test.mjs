/**
 * Wave 9 (R2-10) — USACE reservoir provider tests (co-located).
 *
 * Fixtures are REAL upstream bytes captured live 2026-10-01 from the CWMS
 * Data API (https://cwms-data.usace.army.mil/cwms-data/timeseries):
 *   storage: FTPK.Stor.Inst.~1Day.0.Best-MRBWM (unit=EN → ac-ft),
 *     12 daily rows 2026-09-20…2026-10-01, latest 12,475,000 ac-ft
 *   elevation: FTPK.Elev.Inst.1Hour.0.Best-MRBWM (unit=EN → ft),
 *     latest 2026-10-01T18:00Z 2222.17 ft
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseQuery,
  latestValue,
  parseReservoirPayload,
  buildPayload,
  buildStorageUrl,
  buildElevUrl,
  selectionReservoirs,
  numOrNull,
  RESERVOIRS,
  _usaceInternals,
} from './usace.js';

// Real Fort Peck storage bytes, live 2026-10-01 (unit=EN → ac-ft).
const FTPK_STORAGE_FIXTURE = {
  name: 'FTPK.Stor.Inst.~1Day.0.Best-MRBWM',
  'office-id': 'NWDM',
  units: 'ac-ft',
  interval: 'PT24H',
  values: [
    [1789880400000, 12523999.999999998, 0],
    [1789966800000, 12520000.0, 0],
    [1790744400000, 12478999.999999998, 0],
    [1790830800000, 12475000.0, 0],
  ],
};

// Real Fort Peck pool-elevation bytes, live 2026-10-01 (unit=EN → ft).
const FTPK_ELEV_FIXTURE = {
  name: 'FTPK.Elev.Inst.1Hour.0.Best-MRBWM',
  'office-id': 'NWDM',
  units: 'ft',
  interval: 'PT1H',
  values: [
    [1790553600000, 2222.3, 3],
    [1790874000000, 2222.17, 0],
    [1790877600000, 2222.17, 0],
  ],
};

const FTPK = RESERVOIRS.find((r) => r.id === 'ftpk');
const NOW_MS = Date.parse('2026-10-01T20:00:00Z');

test('numOrNull guards the Number(null)/Number("")===0 trap', () => {
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull('   '), null);
  assert.equal(numOrNull(NaN), null);
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull(0), 0); // real zeros preserved
  assert.equal(numOrNull(12475000), 12475000);
});

test('roster pins the full Missouri mainstem system, 6 reservoirs', () => {
  assert.equal(RESERVOIRS.length, 6);
  const codes = RESERVOIRS.map((r) => r.code).sort();
  assert.deepEqual(codes, ['BEND', 'FTPK', 'FTRA', 'GAPT', 'GARR', 'OAHE']);
  for (const r of RESERVOIRS) {
    assert.match(r.storageSeries, /^\w+\.Stor\.Inst\.~1Day\.0\.Best-MRBWM$/);
    assert.match(r.elevSeries, /^\w+\.Elev\.Inst\.1Hour\.0\.Best-MRBWM$/);
    assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lon));
  }
});

test('parseQuery modes', () => {
  assert.deepEqual(parseQuery(new URLSearchParams('')), { mode: 'all' });
  assert.deepEqual(parseQuery(new URLSearchParams('reservoir=ftpk')), { mode: 'reservoir', reservoir: FTPK });
  assert.deepEqual(parseQuery(new URLSearchParams('reservoir=atlantis')), { mode: 'notfound', reservoir: 'atlantis' });
  assert.throws(() => parseQuery(new URLSearchParams('reservoir=FTPK!')), /usace_bad_reservoir/);
  assert.deepEqual(parseQuery(new URLSearchParams('reservoir=')), { mode: 'all' }); // empty → all
});

test('selectionReservoirs resolves query modes', () => {
  assert.equal(selectionReservoirs({ mode: 'all' }).length, 6);
  assert.deepEqual(selectionReservoirs({ mode: 'reservoir', reservoir: FTPK }), [FTPK]);
});

test('upstream URL builders pin office + series + EN units', () => {
  const stor = new URL(buildStorageUrl(FTPK));
  assert.equal(stor.searchParams.get('office'), 'NWDM');
  assert.equal(stor.searchParams.get('name'), 'FTPK.Stor.Inst.~1Day.0.Best-MRBWM');
  assert.equal(stor.searchParams.get('unit'), 'EN');
  assert.equal(stor.searchParams.get('trim'), 'true');
  const elev = new URL(buildElevUrl(FTPK));
  assert.equal(elev.searchParams.get('name'), 'FTPK.Elev.Inst.1Hour.0.Best-MRBWM');
  assert.equal(elev.searchParams.get('unit'), 'EN');
});

test('latestValue takes the last non-null row (real fixture bytes)', () => {
  const s = latestValue(FTPK_STORAGE_FIXTURE);
  assert.equal(s.value, 12475000);
  assert.equal(s.timeMs, 1790830800000);
  assert.equal(s.quality, 0);
  assert.equal(s.units, 'ac-ft');
  const e = latestValue(FTPK_ELEV_FIXTURE);
  assert.equal(e.value, 2222.17);
  assert.equal(e.timeMs, 1790877600000);
  assert.equal(e.units, 'ft');
});

test('latestValue skips trailing null rows, never zero-fills', () => {
  const env = {
    units: 'ac-ft',
    values: [
      [1790830800000, 12475000.0, 0],
      [1790917200000, null, 0],
      [1791003600000, '', 0],
    ],
  };
  const got = latestValue(env);
  assert.equal(got.value, 12475000); // trailing nulls skipped, not zero-filled
  assert.equal(got.timeMs, 1790830800000);
});

test('latestValue returns null on empty/all-null envelopes', () => {
  assert.equal(latestValue({ units: 'ac-ft', values: [] }), null);
  assert.equal(latestValue({ units: 'ac-ft', values: [[1790830800000, null, 0]] }), null);
  assert.equal(latestValue(null), null);
  assert.equal(latestValue({}), null);
});

test('parseReservoirPayload maps real fixtures with honest ages', () => {
  const row = parseReservoirPayload(FTPK, FTPK_STORAGE_FIXTURE, FTPK_ELEV_FIXTURE, NOW_MS);
  assert.equal(row.ok, true);
  assert.equal(row.id, 'ftpk');
  assert.equal(row.code, 'FTPK');
  assert.equal(row.storage.acFt, 12475000);
  assert.equal(row.storage.time, '2026-10-01T05:00:00.000Z');
  assert.equal(row.storage.ageDays, 0.6); // 15h before NOW_MS
  assert.equal(row.storage.fresh, true);
  assert.equal(row.storage.units, 'ac-ft');
  assert.equal(row.poolElevation.ft, 2222.17);
  assert.equal(row.poolElevation.time, '2026-10-01T18:00:00.000Z');
  assert.equal(row.poolElevation.ageDays, 0.1);
  assert.equal(row.poolElevation.fresh, true);
  assert.equal(row.office, 'NWDM');
});

test('parseReservoirPayload marks stale rows not-fresh without fabricating', () => {
  const oldStor = {
    units: 'ac-ft',
    values: [[Date.parse('2026-09-01T05:00:00Z'), 12000000, 0]],
  };
  const row = parseReservoirPayload(FTPK, oldStor, FTPK_ELEV_FIXTURE, NOW_MS);
  assert.equal(row.storage.ageDays, 30.6);
  assert.equal(row.storage.fresh, false);
  assert.equal(row.storage.acFt, 12000000); // value kept, labeled honestly
  assert.equal(row.poolElevation.fresh, true);
});

test('parseReservoirPayload tolerates one dark series', () => {
  const row = parseReservoirPayload(FTPK, { units: 'ac-ft', values: [] }, FTPK_ELEV_FIXTURE, NOW_MS);
  assert.equal(row.ok, true);
  assert.equal(row.storage, null);
  assert.equal(row.poolElevation.ft, 2222.17);
});

test('parseReservoirPayload throws 502 when both series are dark', () => {
  assert.throws(
    () => parseReservoirPayload(FTPK, { values: [] }, { values: [] }, NOW_MS),
    (e) => e.status === 502 && /usace_invalid_payload/.test(e.message),
  );
});

test('buildPayload envelope carries summary + honesty block', () => {
  const ok = parseReservoirPayload(FTPK, FTPK_STORAGE_FIXTURE, FTPK_ELEV_FIXTURE, NOW_MS);
  const dark = { id: 'garr', code: 'GARR', name: 'Garrison Dam & Reservoir', state: 'ND', ok: false, error: 'x', status: 502 };
  const p = buildPayload([ok, dark], false);
  assert.equal(p.summary.total, 2);
  assert.equal(p.summary.ok, 1);
  assert.equal(p.summary.dark, 1);
  assert.ok(p.source.includes('CWMS'));
  assert.ok(p.honesty.noCapacity.includes('capacity'));
  assert.equal(p.stale, false);
  assert.deepEqual(Object.keys(p.units).sort(), ['poolElevation', 'storage']);
});

test('internals export the pure functions', () => {
  for (const k of ['parseQuery', 'latestValue', 'parseReservoirPayload', 'buildPayload', 'buildStorageUrl', 'buildElevUrl', 'selectionReservoirs', 'clearCaches']) {
    assert.equal(typeof _usaceInternals[k], 'function', k);
  }
});
