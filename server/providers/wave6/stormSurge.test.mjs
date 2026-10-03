/**
 * Wave 6 — R2-20 storm-surge residuals (tides.js extension) — provider tests.
 *
 * Fixtures: server/providers/wave6/fixtures/stormsurge-{pred,obs}-2026-10-03-8638610.json
 * are LIVE CO-OPS bytes captured 2026-10-03 03:47 EDT (Sewells Point 8638610):
 *   pred: product=predictions, interval=h, begin_date=20261001, end_date=20261003
 *         (72 hourly rows, no `type` field)
 *   obs:  product=water_level, date=recent, datum=MLLW (719 six-minute rows)
 * Summary expectations were computed by an INDEPENDENT python3 statement over
 * the same fixture bytes BEFORE the provider ran on them (error-discipline):
 *   matched 57/72; 2026-10-02T00:00:00Z → pred 0.666, obs 1.02, residual 0.354, n=11
 *   summary: max 0.556 @ 2026-10-01T05:00Z; min -0.045 @ 2026-10-02T23:00Z;
 *            mean 0.258; latest 0.447 @ 2026-10-03T08:00Z.
 * If these disagree with the provider, the provider is wrong until proven
 * otherwise against the fixture bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseStormSurgeQuery,
  parseSurgeWaterLevel,
  parsePredictions,
  matchResiduals,
  summarizeResiduals,
  stormSurgePredictionsUrl,
  stormSurgeProxy,
  _tidesInternals,
} from './tides.js';

const { STORM_SURGE_HONESTY } = _tidesInternals;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PRED = JSON.parse(
  readFileSync(
    join(ROOT, 'server', 'providers', 'wave6', 'fixtures', 'stormsurge-pred-2026-10-03-8638610.json'),
    'utf8',
  ),
);
const OBS = JSON.parse(
  readFileSync(
    join(ROOT, 'server', 'providers', 'wave6', 'fixtures', 'stormsurge-obs-2026-10-03-8638610.json'),
    'utf8',
  ),
);

test('stormSurgePredictionsUrl: hourly predictions, days window, station', () => {
  const url = stormSurgePredictionsUrl('8638610', 2);
  assert.ok(url.includes('product=predictions'), 'predictions product');
  assert.ok(url.includes('interval=h'), 'hourly interval');
  assert.ok(url.includes('station=8638610'), 'station');
  assert.ok(url.includes('datum=MLLW'), 'datum required');
  const end = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const begin = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
  assert.ok(url.includes(`begin_date=${begin}`), 'begin_date');
  assert.ok(url.includes(`end_date=${end}`), 'end_date');
});

test('parseSurgeWaterLevel: all 719 rows, unsliced (newest kept)', () => {
  const rows = parseSurgeWaterLevel(OBS);
  assert.equal(rows.length, 719, 'no 500-row slice — residuals need the newest gauges');
  assert.equal(rows[0].time, '2026-09-30T07:48:00.000Z');
  assert.equal(rows[rows.length - 1].time, '2026-10-03T07:36:00.000Z');
  assert.equal(rows[0].quality, 'p');
  assert.ok(Number.isFinite(rows[0].feet));
});

test('parsePredictions: 72 hourly rows, no type field', () => {
  const rows = parsePredictions(PRED);
  assert.equal(rows.length, 72);
  assert.equal(rows[0].time, '2026-10-01T00:00:00.000Z');
  assert.equal(rows[0].type, null);
  assert.equal(rows[0].feet, 0.753);
});

test('matchResiduals: python-anchored row at 2026-10-02T00:00Z', () => {
  const obs = parseSurgeWaterLevel(OBS);
  const pred = parsePredictions(PRED);
  const res = matchResiduals(obs, pred);
  assert.equal(res.length, 72, 'one row per prediction hour');
  const row = res.find((r) => r.time === '2026-10-02T00:00:00.000Z');
  assert.ok(row, 'row exists');
  assert.equal(row.predictedFeet, 0.666);
  assert.equal(row.observedFeet, 1.02);
  assert.equal(row.residualFeet, 0.354);
  assert.equal(row.obsCount, 11);
});

test('matchResiduals: unmatched tail hours read null, never interpolated', () => {
  const obs = parseSurgeWaterLevel(OBS);
  const pred = parsePredictions(PRED);
  const res = matchResiduals(obs, pred);
  const matched = res.filter((r) => Number.isFinite(r.residualFeet));
  assert.equal(matched.length, 57, '57/72 matched (python-anchored)');
  const tail = res.find((r) => r.time === '2026-10-03T23:00:00.000Z');
  assert.ok(tail, 'tail row exists');
  assert.equal(tail.residualFeet, null);
  assert.equal(tail.observedFeet, null);
  assert.equal(tail.obsCount, 0);
  assert.ok(Number.isFinite(tail.predictedFeet), 'prediction still present');
  for (const r of res) {
    assert.ok(
      r.residualFeet === null || Number.isFinite(r.residualFeet),
      'no NaN/undefined residuals',
    );
  }
});

test('summarizeResiduals: python-anchored summary', () => {
  const obs = parseSurgeWaterLevel(OBS);
  const pred = parsePredictions(PRED);
  const s = summarizeResiduals(matchResiduals(obs, pred));
  assert.equal(s.matchedHours, 57);
  assert.equal(s.maxResidualFeet, 0.556);
  assert.equal(s.maxResidualTime, '2026-10-01T05:00:00.000Z');
  assert.equal(s.minResidualFeet, -0.045);
  assert.equal(s.minResidualTime, '2026-10-02T23:00:00.000Z');
  assert.equal(s.meanResidualFeet, 0.258);
  assert.equal(s.latestResidualFeet, 0.447);
  assert.equal(s.latestResidualTime, '2026-10-03T08:00:00.000Z');
});

test('summarizeResiduals: empty input degrades honestly', () => {
  const s = summarizeResiduals([]);
  assert.equal(s.matchedHours, 0);
  assert.equal(s.maxResidualFeet, null);
  assert.equal(s.latestResidualTime, null);
});

test('parseStormSurgeQuery: defaults and valid params', () => {
  const d = parseStormSurgeQuery({ url: '/api/storm-surge' });
  assert.deepEqual(d, { station: '8638610', stations: null, days: 2 });
  const q = parseStormSurgeQuery({ url: '/api/storm-surge?station=9414290&days=3' });
  assert.equal(q.station, '9414290');
  assert.equal(q.days, 3);
  const m = parseStormSurgeQuery({ url: '/api/storm-surge?stations=8638610,9414290&days=1' });
  assert.deepEqual(m.stations, ['8638610', '9414290']);
  assert.equal(m.days, 1);
});

test('parseStormSurgeQuery: bad inputs → 400', () => {
  for (const url of [
    '/api/storm-surge?station=abc',
    '/api/storm-surge?station=8638610!',
    '/api/storm-surge?days=0',
    '/api/storm-surge?days=4',
    '/api/storm-surge?days=abc',
    '/api/storm-surge?stations=' + Array.from({ length: 11 }, (_, i) => `100000${i}`).join(','),
    '/api/storm-surge?stations=8638610,bogus',
  ]) {
    assert.throws(() => parseStormSurgeQuery({ url }), (e) => e?.status === 400, url);
  }
});

test('STORM_SURGE_HONESTY: all mandatory labels present', () => {
  for (const k of ['definition', 'notAForecast', 'drivers', 'unmatched', 'quality', 'datum']) {
    assert.ok(
      typeof STORM_SURGE_HONESTY[k] === 'string' && STORM_SURGE_HONESTY[k].length > 20,
      `honesty key ${k}`,
    );
  }
  assert.ok(/not a surge forecast/i.test(STORM_SURGE_HONESTY.notAForecast));
  assert.ok(/never interpolated/i.test(STORM_SURGE_HONESTY.unmatched));
});

test('stormSurgeProxy: registers /api/storm-surge, 405 on non-GET (no network)', async () => {
  const plugin = stormSurgeProxy();
  assert.equal(plugin.name, 'storm-surge');
  const routes = [];
  plugin.configureServer({ middlewares: { use: (r, fn) => routes.push([r, fn]) } });
  assert.equal(routes.length, 1);
  assert.equal(routes[0][0], '/api/storm-surge');
  const handler = routes[0][1];
  let status;
  let body;
  const res = {
    writeHead: (s) => {
      status = s;
    },
    end: (b) => {
      body = JSON.parse(b);
    },
  };
  await handler({ method: 'POST', url: '/api/storm-surge' }, res);
  assert.equal(status, 405);
  assert.equal(body.error, 'method_not_allowed');
});
