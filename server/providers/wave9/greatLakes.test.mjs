/**
 * Wave 9 (R2-11) — Great Lakes water-level provider tests (co-located).
 *
 * Fixtures are REAL upstream bytes captured live 2026-10-01 from Zenodo
 * (concept record 14182902 → version doi 10.5281/zenodo.21908489):
 *   record API: 5 CSVs Monthly_mean_water_levels_Lake_<Lake>_1918-2025.csv
 *   Lake Superior CSV: trimmed to the global_attributes header lines + the
 *   data header + the 12 real 2025 rows (latest 2025-12: 183.27 m).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseQuery,
  parseRecordApi,
  parseLakeCsv,
  monthsSince,
  buildLakeRow,
  buildPayload,
  selectionLakes,
  numOrNull,
  LAKES,
  _greatLakesInternals,
} from './greatLakes.js';

// Real Lake Superior CSV bytes, live 2026-10-01 (trimmed: comments + header + 2025 rows).
const SUPERIOR_FIXTURE = [
  '# global_attributes:title: Lake Superior lake-wide average monthly mean water level.,,,',
  '# global_attributes:source: Coordinated using data computed by Environment and Climate Change Canada (ECCC) and the United States Army Corps of Engineers (USACE) from hydrometric observations collected by the Canadian Hydrographic Service (CHS) and the National Oceanic and Atmospheric Administration (NOAA).,,,',
  '# global_attributes:summary: The Lake Superior lake-wide average monthly mean water level is computed by ECCC and USACE from daily mean water level observations collected from gauges located around the lake and subsequently coordinated by the Coordinating Committee. The data are in meters with reference to IGLD 1985. ,,,',
  ',,,',
  'time,time_bnds_start,time_bnds_end,monthly_lakewide_average_water_level',
  '1/1/2025,1/1/2025,1/31/2025,183.18',
  '2/1/2025,2/1/2025,2/28/2025,183.1',
  '3/1/2025,3/1/2025,3/31/2025,183.08',
  '4/1/2025,4/1/2025,4/30/2025,183.13',
  '5/1/2025,5/1/2025,5/31/2025,183.28',
  '6/1/2025,6/1/2025,6/30/2025,183.32',
  '7/1/2025,7/1/2025,7/31/2025,183.43',
  '8/1/2025,8/1/2025,8/31/2025,183.49',
  '9/1/2025,9/1/2025,9/30/2025,183.49',
  '10/1/2025,10/1/2025,10/31/2025,183.44',
  '11/1/2025,11/1/2025,11/30/2025,183.36',
  '12/1/2025,12/1/2025,12/31/2025,183.27',
].join('\n');

// Real record-API shape, live 2026-10-01 (file list trimmed to the 5 CSVs + 1 PDF).
const RECORD_FIXTURE = {
  doi: '10.5281/zenodo.21908489',
  conceptrecid: '14182902',
  files: [
    { key: 'Monthly_mean_water_levels_Lake_Superior_1918-2025.csv', size: 50337, links: { self: 'https://zenodo.org/api/records/21908489/files/Monthly_mean_water_levels_Lake_Superior_1918-2025.csv/content' } },
    { key: 'Monthly_mean_water_levels_Lake_Michigan-Huron_1918-2025.csv', size: 50333, links: { self: 'https://zenodo.org/api/records/21908489/files/Monthly_mean_water_levels_Lake_Michigan-Huron_1918-2025.csv/content' } },
    { key: 'Monthly_mean_water_levels_Lake_StClair_1918-2025.csv', size: 50104, links: { self: 'https://zenodo.org/api/records/21908489/files/Monthly_mean_water_levels_Lake_StClair_1918-2025.csv/content' } },
    { key: 'Monthly_mean_water_levels_Lake_Erie_1918-2025.csv', size: 50246, links: { self: 'https://zenodo.org/api/records/21908489/files/Monthly_mean_water_levels_Lake_Erie_1918-2025.csv/content' } },
    { key: 'Monthly_mean_water_levels_Lake_Ontario_1918-2025.csv', size: 48973, links: { self: 'https://zenodo.org/api/records/21908489/files/Monthly_mean_water_levels_Lake_Ontario_1918-2025.csv/content' } },
    { key: 'Monthly_mean_water_levels_Lake_Superior_1918-2025_metadata.pdf', size: 80832, links: { self: 'https://zenodo.org/api/records/21908489/files/x.pdf/content' } },
  ],
};

const NOW_2026_10_01 = Date.UTC(2026, 9, 1);

test('numOrNull guards the Number("")===0 trap', () => {
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull('   '), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull('183.27'), 183.27);
  assert.equal(numOrNull(183.27), 183.27);
  assert.equal(numOrNull('abc'), null);
});

test('parseQuery: lake filter, notfound, malformed, default', () => {
  const q = (s) => new URL(`http://x/?${s}`).searchParams;
  assert.deepEqual(parseQuery(q('lake=erie')).lake.id, 'erie');
  assert.equal(parseQuery(q('lake=erie')).mode, 'lake');
  assert.equal(parseQuery(q('lake=atlantis')).mode, 'notfound');
  assert.equal(parseQuery(q('')).mode, 'all');
  assert.throws(() => parseQuery(q('lake=BAD!')), /greatlakes_bad_lake/);
});

test('selectionLakes returns the one or all five', () => {
  assert.equal(selectionLakes({ mode: 'all' }).length, 5);
  assert.deepEqual(selectionLakes({ mode: 'lake', lake: LAKES[3] }).map((l) => l.id), ['erie']);
});

test('parseRecordApi maps all five lakes to their content URLs', () => {
  const files = parseRecordApi(RECORD_FIXTURE);
  assert.equal(files.length, 5);
  const byId = Object.fromEntries(files.map((f) => [f.lake.id, f.contentUrl]));
  assert.ok(byId.superior.endsWith('Lake_Superior_1918-2025.csv/content'));
  assert.ok(byId['michigan-huron'].includes('Lake_Michigan-Huron_1918-2025.csv/content'));
  assert.ok(byId.stclair.includes('Lake_StClair_1918-2025.csv/content'));
  assert.ok(byId.erie.includes('Lake_Erie_1918-2025.csv/content'));
  assert.ok(byId.ontario.includes('Lake_Ontario_1918-2025.csv/content'));
});

test('parseRecordApi throws 502 when a lake CSV is missing', () => {
  const broken = { files: RECORD_FIXTURE.files.filter((f) => !f.key.includes('Lake_Erie_')) };
  assert.throws(() => parseRecordApi(broken), (e) => e.status === 502 && /Erie|erie/.test(e.message));
  assert.throws(() => parseRecordApi({}), (e) => e.status === 502);
});

test('parseRecordApi tolerates future key years (1918-2026 style)', () => {
  const future = {
    files: RECORD_FIXTURE.files.map((f) =>
      f.key.endsWith('.csv')
        ? { ...f, key: f.key.replace('1918-2025', '1918-2026'), links: { self: f.links.self.replace('1918-2025', '1918-2026') } }
        : f,
    ),
  };
  assert.equal(parseRecordApi(future).length, 5);
});

test('parseLakeCsv parses the real Superior fixture (12 months)', () => {
  const months = parseLakeCsv(SUPERIOR_FIXTURE);
  assert.equal(months.length, 12);
  assert.deepEqual(months[0], { month: '2025-01', levelM: 183.18 });
  assert.deepEqual(months[11], { month: '2025-12', levelM: 183.27 });
  // comment lines, blank ',,,' lines, and the header row are skipped, not parsed
  assert.ok(months.every((r) => /^\d{4}-\d{2}$/.test(r.month)));
});

test('parseLakeCsv skips null/empty values, never zero-fills', () => {
  const months = parseLakeCsv('time,time_bnds_start,time_bnds_end,monthly_lakewide_average_water_level\n1/1/2025,1/1/2025,1/31/2025,\n2/1/2025,2/1/2025,2/28/2025,183.10\n');
  assert.equal(months.length, 1);
  assert.equal(months[0].levelM, 183.1);
});

test('monthsSince computes month lag against a pinned now', () => {
  assert.equal(monthsSince('2025-12', NOW_2026_10_01), 10);
  assert.equal(monthsSince('2026-10', NOW_2026_10_01), 0);
  assert.equal(monthsSince('2024-06', NOW_2026_10_01), 28);
});

test('buildLakeRow: latest, mean, anomaly, records, feet, freshness', () => {
  const months = parseLakeCsv(SUPERIOR_FIXTURE);
  const row = buildLakeRow(LAKES[0], months, NOW_2026_10_01);
  assert.equal(row.ok, true);
  assert.equal(row.datum, 'IGLD 1985');
  assert.deepEqual(row.latest.month, '2025-12');
  assert.equal(row.latest.levelM, 183.27);
  // 183.27 m × 3.28084 = 601.2795… → 601.28 (test math verified vs python3)
  assert.equal(row.latest.levelFt, 601.28);
  // mean of the 12 real 2025 rows = 2199.57/12 = 183.2975 → 183.298
  assert.equal(row.mean.levelM, 183.298);
  // anomaly 183.27 − 183.2975 = −0.0275 → −0.028
  assert.equal(row.anomaly.levelM, -0.028);
  assert.ok(row.anomaly.vs.includes('2025-01'));
  // record high 183.49 first seen 2025-08; record low 183.08 in 2025-03
  assert.deepEqual(row.recordHigh.month, '2025-08');
  assert.equal(row.recordHigh.levelM, 183.49);
  assert.deepEqual(row.recordLow.month, '2025-03');
  assert.equal(row.recordLow.levelM, 183.08);
  // 10-month lag (2025-12 → 2026-10) is within the 14-month annual-cadence window
  assert.equal(row.latest.lagMonths, 10);
  assert.equal(row.fresh, true);
  assert.equal(row.recent.length, 12);
  assert.deepEqual(row.gauges.noaa, ['Duluth MN', 'Marquette G.C. MI', 'Point Iroquois MI']);
});

test('buildLakeRow marks an overdue record dark, honestly', () => {
  const months = parseLakeCsv(SUPERIOR_FIXTURE);
  const staleNow = Date.UTC(2028, 0, 1); // 25 months after 2025-12
  const row = buildLakeRow(LAKES[0], months, staleNow);
  assert.equal(row.fresh, false);
  assert.equal(row.latest.lagMonths, 25);
});

test('buildLakeRow throws 502 on empty input', () => {
  assert.throws(() => buildLakeRow(LAKES[0], []), (e) => e.status === 502);
});

test('buildPayload: summary, honesty block, record DOI', () => {
  const months = parseLakeCsv(SUPERIOR_FIXTURE);
  const okRow = buildLakeRow(LAKES[0], months, NOW_2026_10_01);
  const darkRow = { id: 'erie', name: 'Lake Erie', ok: false, error: 'x', status: 502 };
  const payload = buildPayload([okRow, darkRow], '10.5281/zenodo.21908489', false);
  assert.equal(payload.summary.total, 2);
  assert.equal(payload.summary.ok, 1);
  assert.equal(payload.summary.dark, 1);
  assert.equal(payload.summary.fresh, 1);
  assert.equal(payload.recordDoi, '10.5281/zenodo.21908489');
  assert.ok(payload.honesty.monthlyMeans.includes('not real-time'));
  assert.ok(payload.honesty.michiganHuron.includes('one hydrologic unit'));
  assert.ok(payload.honesty.updateLag.includes('annually'));
  assert.ok(payload.honesty.datum.includes('IGLD 1985'));
  assert.ok(payload.attribution.includes('Coordinating Committee'));
});

test('internals export the record API URL and a cache clearer', () => {
  assert.equal(_greatLakesInternals.RECORD_API_URL, 'https://zenodo.org/api/records/14182902');
  assert.equal(typeof _greatLakesInternals.clearCaches, 'function');
});
