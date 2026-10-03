/**
 * Wave 9 — earthVitals provider tests (real 2026-10-03 live bytes, no mocks of shape).
 *
 * Fixtures:
 *   seaice-north-2026-10-03.csv / seaice-south-2026-10-03.csv — NSIDC G02135 v4.0,
 *     trimmed to the last 400 data rows + 2 header rows (real bytes).
 *   ozone-ytd-2026-10-03.txt — Ozone Watch ytd_data.txt, full 2.5KB capture.
 *   pheno-leaf-pembroke-2026-10-03.json / pheno-bloom-pembroke-2026-10-03.json —
 *     USA-NPN GetFeatureInfo JSON at Pembroke VA (37.32,-80.74).
 *
 * Anchor values below were computed with an independent python3 statement over
 * the SAME fixture bytes (never hand-typed expectations).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  numOrNull,
  parseSeaIceCsv,
  buildSeaIceSection,
  parseOzoneYtd,
  buildOzonePayload,
  lonLatToPixel,
  parsePhenoFeature,
  seaIceProxy,
  ozoneProxy,
  phenoProxy,
  _earthVitalsInternals,
} from './earthVitals.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const northCsv = readFileSync(join(FIX, 'seaice-north-2026-10-03.csv'), 'utf8');
const southCsv = readFileSync(join(FIX, 'seaice-south-2026-10-03.csv'), 'utf8');
const ozoneTxt = readFileSync(join(FIX, 'ozone-ytd-2026-10-03.txt'), 'utf8');
const leafJson = readFileSync(join(FIX, 'pheno-leaf-pembroke-2026-10-03.json'), 'utf8');
const bloomJson = readFileSync(join(FIX, 'pheno-bloom-pembroke-2026-10-03.json'), 'utf8');

// --- numOrNull: the Number('')===0 trap ------------------------------------

test('numOrNull guards the empty-string trap but preserves real zeros', () => {
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull('   '), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull('not-a-number'), null);
  assert.equal(numOrNull('0'), 0);
  assert.equal(numOrNull('0.0'), 0);
  assert.equal(numOrNull('5.713'), 5.713);
});

// --- sea ice ----------------------------------------------------------------

test('north fixture parses 400 rows; latest row is 2026-10-02 / 5.713', () => {
  const rows = parseSeaIceCsv(northCsv);
  assert.equal(rows.length, 400);
  const last = rows[rows.length - 1];
  assert.deepEqual([last.y, last.m, last.d], [2026, 10, 2]);
  assert.equal(last.extent, 5.713);
  assert.equal(last.missing, 0);
});

test('south fixture parses 400 rows; latest row is 2026-10-02 / 16.650', () => {
  const rows = parseSeaIceCsv(southCsv);
  assert.equal(rows.length, 400);
  const last = rows[rows.length - 1];
  assert.deepEqual([last.y, last.m, last.d], [2026, 10, 2]);
  assert.equal(last.extent, 16.65);
});

test('parser skips the 2 header rows and never reads units as data', () => {
  const rows = parseSeaIceCsv(northCsv);
  assert.ok(rows.every((r) => r.y >= 1978 && r.y <= 2027));
  assert.ok(rows.every((r) => r.extent > 0 && r.extent < 30));
});

test('north section: day-of-year stats match the python anchor', () => {
  const sec = buildSeaIceSection('north', parseSeaIceCsv(northCsv));
  assert.equal(sec.ok, true);
  assert.equal(sec.latest.date, '2026-10-02');
  assert.equal(sec.latest.extentMkm2, 5.713);
  // anchor (400-row window): doy(10,02) mean 5.502, n=2, min 5.291, max 5.713
  assert.equal(sec.dayOfYear.recordN, 2);
  assert.equal(sec.dayOfYear.recordMeanMkm2, 5.502);
  assert.equal(sec.dayOfYear.recordMin.value, 5.291);
  assert.equal(sec.dayOfYear.recordMax.value, 5.713);
  assert.equal(sec.dayOfYear.anomalyMkm2, 0.211);
});

test('south section: day-of-year stats match the python anchor', () => {
  const sec = buildSeaIceSection('south', parseSeaIceCsv(southCsv));
  assert.equal(sec.ok, true);
  assert.equal(sec.latest.date, '2026-10-02');
  assert.equal(sec.latest.extentMkm2, 16.65);
  // anchor: doy(10,02) mean 17.072, n=2, min 16.65, max 17.495
  assert.equal(sec.dayOfYear.recordN, 2);
  assert.equal(sec.dayOfYear.recordMeanMkm2, 17.072);
  assert.equal(sec.dayOfYear.recordMin.value, 16.65);
  assert.equal(sec.dayOfYear.recordMax.value, 17.495);
  assert.equal(sec.dayOfYear.anomalyMkm2, -0.422);
});

test('series365 caps at 365 points, oldest-first', () => {
  const sec = buildSeaIceSection('north', parseSeaIceCsv(northCsv));
  assert.equal(sec.series365.length, 365);
  assert.equal(sec.series365[sec.series365.length - 1].date, '2026-10-02');
  assert.ok(sec.series365[0].date < sec.series365[364].date);
});

test('empty rows read not-ok, never fabricated', () => {
  const sec = buildSeaIceSection('north', []);
  assert.equal(sec.ok, false);
});

// --- ozone ------------------------------------------------------------------

test('ozone fixture parses 46 annual rows; 1995 absent upstream', () => {
  const rows = parseOzoneYtd(ozoneTxt);
  assert.equal(rows.length, 46); // 1979-2025 = 47 years, minus 1995
  assert.ok(!rows.some((r) => r.year === 1995));
  assert.equal(rows[0].year, 1979);
  assert.equal(rows[rows.length - 1].year, 2025);
});

test('ozone latest row: 2025 max area 22.9 on 2025-09-09, min ozone 127 on 2025-09-25', () => {
  const rows = parseOzoneYtd(ozoneTxt);
  const latest = rows[rows.length - 1];
  assert.equal(latest.areaMkm2, 22.9);
  assert.equal(latest.areaDate, '2025-09-09');
  assert.equal(latest.ozoneDU, 127);
  assert.equal(latest.ozoneDate, '2025-09-25');
});

test('ozone records: 2000 largest hole 29.9, 1994 lowest ozone 73.0', () => {
  const payload = buildOzonePayload(parseOzoneYtd(ozoneTxt), false);
  assert.deepEqual(payload.records.largestHole, { valueMkm2: 29.9, date: '2000-09-09', year: 2000 });
  assert.deepEqual(payload.records.lowestOzone, { valueDU: 73, date: '1994-09-30', year: 1994 });
});

test('ozone payload carries decade means and the honesty block', () => {
  const payload = buildOzonePayload(parseOzoneYtd(ozoneTxt), false);
  assert.ok(payload.decadeMeans.length >= 4);
  const d2000s = payload.decadeMeans.find((d) => d.decade === '2000s');
  assert.ok(d2000s && d2000s.n === 10);
  assert.ok(payload.honesty.annualOnly.includes('ANNUAL'));
  assert.ok(payload.honesty.headerMislabel.includes('MMDD'));
});

// --- phenology ----------------------------------------------------------------

test('lonLatToPixel pins the probe pixel grid (formula, not the probe coords)', () => {
  // (-80.74+125)/59*1180 = 885.2 -> 885 ; (50-37.32)/26*520 = 253.6 -> 254
  assert.deepEqual(lonLatToPixel(-80.74, 37.32), { x: 885, y: 254 });
});

test('Pembroke VA fixtures parse: leaf -7d, bloom -13d (spring arrived early)', () => {
  assert.equal(parsePhenoFeature(leafJson, 'LEAF_OUT_DAY_DIFF'), -7);
  assert.equal(parsePhenoFeature(bloomJson, 'BLOOM_DAY_DIFF'), -13);
});

test('parsePhenoFeature reads null on empty features / junk, never 0', () => {
  assert.equal(parsePhenoFeature('{"type":"FeatureCollection","features":[]}', 'LEAF_OUT_DAY_DIFF'), null);
  assert.equal(parsePhenoFeature('not json', 'LEAF_OUT_DAY_DIFF'), null);
  assert.equal(parsePhenoFeature(leafJson, 'BLOOM_DAY_DIFF'), null); // wrong key, not 0
});

test('PHENO_POINTS pins 6 CONUS points with ids', () => {
  const pts = _earthVitalsInternals.PHENO_POINTS;
  assert.equal(pts.length, 6);
  assert.ok(pts.every((p) => p.id && Number.isFinite(p.lat) && Number.isFinite(p.lon)));
  assert.ok(pts.some((p) => p.id === 'pembroke-va'));
});

// --- proxy wiring (no network: fake middleware collector) ---------------------

function collectMount(proxyFactory) {
  const seen = [];
  const p = proxyFactory();
  p.configureServer({ middlewares: { use: (route, fn) => seen.push([route, typeof fn]) } });
  return { name: p.name, seen };
}

test('seaIceProxy mounts /api/sea-ice', () => {
  const { name, seen } = collectMount(seaIceProxy);
  assert.equal(name, 'sea-ice');
  assert.deepEqual(seen, [['/api/sea-ice', 'function']]);
});

test('ozoneProxy mounts /api/ozone', () => {
  const { name, seen } = collectMount(ozoneProxy);
  assert.equal(name, 'ozone');
  assert.deepEqual(seen, [['/api/ozone', 'function']]);
});

test('phenoProxy mounts /api/phenology', () => {
  const { name, seen } = collectMount(phenoProxy);
  assert.equal(name, 'phenology');
  assert.deepEqual(seen, [['/api/phenology', 'function']]);
});

test('ozone ?year=bogus -> 400 without touching the network', async () => {
  const seen = [];
  const p = ozoneProxy();
  p.configureServer({ middlewares: { use: (route, fn) => seen.push(fn) } });
  const handler = seen[0];
  let status = null;
  let body = null;
  const res = {
    writeHead: (s) => { status = s; },
    end: (b) => { body = JSON.parse(b); },
  };
  await handler({ method: 'GET', url: '/api/ozone?year=bogus', headers: {} }, res);
  assert.equal(status, 400);
  assert.equal(body.error, 'ozone_bad_year');
});

test('sea-ice ?hemi=bogus -> 400 without touching the network', async () => {
  const seen = [];
  seaIceProxy().configureServer({ middlewares: { use: (route, fn) => seen.push(fn) } });
  let status = null;
  let body = null;
  const res = {
    writeHead: (s) => { status = s; },
    end: (b) => { body = JSON.parse(b); },
  };
  await seen[0]({ method: 'GET', url: '/api/sea-ice?hemi=bogus', headers: {} }, res);
  assert.equal(status, 400);
  assert.equal(body.error, 'seaice_bad_hemi');
});

test('non-GET -> 405 on all three proxies', async () => {
  for (const factory of [seaIceProxy, ozoneProxy, phenoProxy]) {
    const seen = [];
    factory().configureServer({ middlewares: { use: (route, fn) => seen.push(fn) } });
    let status = null;
    const res = { writeHead: (s) => { status = s; }, end: () => {} };
    await seen[0]({ method: 'POST', url: '/', headers: {} }, res);
    assert.equal(status, 405);
  }
});
