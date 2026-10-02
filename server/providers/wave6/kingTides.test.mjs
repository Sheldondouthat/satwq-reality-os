import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { _tidesInternals } from './tides.js';

const {
  parsePredictions,
  parseKingTidesQuery,
  rankKingTides,
  monthlyMaxima,
  annotateKingTideEvent,
  yearPredictionsUrl,
  KING_TIDES_HONESTY,
} = _tidesInternals;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Fixture: REAL year-long CO-OPS predictions bytes captured live 2026-10-02
// (api.tidesandcurrents.noaa.gov, HTTP 200, station 8638610 Sewells Point,
// product=predictions, interval=hilo, begin 20260101 end 20261231).
const FIXTURE = JSON.parse(
  readFileSync(join(ROOT, 'server', 'providers', 'wave6', 'fixtures', 'kingtides-2026-8638610.json'), 'utf8'),
);

const READINGS = parsePredictions(FIXTURE);

test('fixture parses to the real 2026 event set', () => {
  assert.equal(READINGS.length, 1410);
  const highs = READINGS.filter((r) => r.type === 'H');
  assert.equal(highs.length, 705);
});

test('rankKingTides returns the top-5 predicted highs, ranked', () => {
  const top = rankKingTides(READINGS, 5);
  assert.equal(top.length, 5);
  // Independent check (python3 over the same fixture bytes):
  // [3.456, 3.444, 3.414, 3.392, 3.388]
  assert.deepEqual(
    top.map((t) => t.feet),
    [3.456, 3.444, 3.414, 3.392, 3.388],
  );
  top.forEach((t, i) => {
    assert.equal(t.rank, i + 1);
    assert.equal(t.kingTide, true);
  });
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].feet >= top[i].feet);
});

test('rankKingTides annotates lunar geometry on every event', () => {
  const [first] = rankKingTides(READINGS, 1);
  assert.equal(typeof first.moonPhase, 'string');
  assert.ok(first.moonPhase.length > 0);
  assert.ok(Number.isFinite(first.elongationDeg));
  assert.ok(first.elongationDeg >= 0 && first.elongationDeg <= 180);
  assert.ok(Number.isFinite(first.moonDistanceKm));
  assert.ok(first.moonDistanceKm > 350000 && first.moonDistanceKm < 410000);
  assert.equal(typeof first.springWindow, 'boolean');
  assert.equal(typeof first.perigean, 'boolean');
  assert.equal(first.springWindow, first.nearNewMoon || first.nearFullMoon);
});

test('lunar annotation is anchored: 2026-08-12 eclipse = new moon', () => {
  // Independent anchor: the 2026-08-12 total solar eclipse (max ~17:47 UTC)
  // happened at new moon. The repo ephemeris must read ~0° elongation there.
  const ann = annotateKingTideEvent({ time: '2026-08-12T17:47:00.000Z', feet: 2.0 });
  assert.ok(ann.elongationDeg < 10, `elongation ${ann.elongationDeg} too far from new moon`);
  assert.equal(ann.moonPhase, 'New Moon');
  assert.equal(ann.nearNewMoon, true);
  assert.equal(ann.springWindow, true);
});

test('monthlyMaxima covers all 12 months of 2026', () => {
  const months = monthlyMaxima(READINGS);
  assert.equal(months.length, 12);
  assert.deepEqual(
    months.map((m) => m.month),
    Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`),
  );
  months.forEach((m) => {
    assert.equal(m.monthlyMax, true);
    assert.ok(Number.isFinite(m.feet));
  });
  // Every monthly max must be one of the year's highs (never synthesized).
  const highFeet = new Set(READINGS.filter((r) => r.type === 'H').map((r) => r.feet));
  months.forEach((m) => assert.ok(highFeet.has(m.feet)));
});

test('parseKingTidesQuery defaults and validation', () => {
  const def = parseKingTidesQuery({ url: '/api/king-tides' });
  assert.equal(def.station, '8638610');
  assert.equal(def.stations, null);
  assert.equal(def.year, new Date().getUTCFullYear());
  assert.equal(def.top, 5);

  const q = parseKingTidesQuery({ url: '/api/king-tides?station=9414290&year=2027&top=3' });
  assert.equal(q.station, '9414290');
  assert.equal(q.year, 2027);
  assert.equal(q.top, 3);

  const multi = parseKingTidesQuery({ url: '/api/king-tides?stations=8638610,9414290' });
  assert.deepEqual(multi.stations, ['8638610', '9414290']);

  for (const bad of [
    '/api/king-tides?year=abcd',
    '/api/king-tides?year=1899',
    '/api/king-tides?top=0',
    '/api/king-tides?top=21',
    '/api/king-tides?top=abc',
    '/api/king-tides?station=BAD!',
    '/api/king-tides?stations=8638610,'.repeat(11).slice(0, -1),
  ]) {
    assert.throws(() => parseKingTidesQuery({ url: bad }), (e) => e?.status === 400, bad);
  }
});

test('yearPredictionsUrl pins the CO-OPS year-range contract', () => {
  const u = yearPredictionsUrl('8638610', 2026);
  assert.ok(u.includes('product=predictions'));
  assert.ok(u.includes('interval=hilo'));
  assert.ok(u.includes('datum=MLLW'));
  assert.ok(u.includes('begin_date=20260101'));
  assert.ok(u.includes('end_date=20261231'));
  assert.ok(u.includes('station=8638610'));
});

test('parsePredictions never zero-fills empty values (Number("")===0 trap)', () => {
  const rows = parsePredictions({
    predictions: [
      { t: '2026-01-01 00:00', v: '', type: 'H' },
      { t: '2026-01-01 06:00', v: '2.5', type: 'H' },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feet, 2.5);
});

test('honesty block carries the mandatory labels', () => {
  for (const k of ['kingTideDefinition', 'predictionsNotObserved', 'lunarGeometry', 'springWindow', 'datum']) {
    assert.ok(typeof KING_TIDES_HONESTY[k] === 'string' && KING_TIDES_HONESTY[k].length > 0, k);
  }
  assert.match(KING_TIDES_HONESTY.kingTideDefinition, /not observed/i);
  assert.match(KING_TIDES_HONESTY.predictionsNotObserved, /can exceed predictions/i);
});
