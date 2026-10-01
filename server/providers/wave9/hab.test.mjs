/**
 * Wave 9 (R2-9) — HAB provider tests (co-located).
 *
 * Fixture is REAL upstream bytes captured live 2026-10-01 from
 * https://erddap.sccoos.org/erddap/tabledap/HABs-SantaMonicaPier.json
 * (2 weekly rows; latest 2026-09-28T19:00:00Z). Column units per ERDDAP:
 * taxa in cells/L, pDA/tDA/dDA in ng/mL.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseQuery,
  parseStationPayload,
  buildPayload,
  buildUpstreamUrl,
  selectionStations,
  taxonAlert,
  numOrNull,
  BLOOM_CELLS_PER_L,
  PDA_ALERT_NG_PER_ML,
  STATIONS,
  TAXA_VARS,
  OTHER_VARS,
  _habInternals,
} from './hab.js';

const COLS = ['time', 'latitude', 'longitude', ...TAXA_VARS, ...OTHER_VARS];

// Real Santa Monica Pier bytes, live 2026-10-01 (2 rows; latest last).
const SANTA_MONICA_FIXTURE = {
  table: {
    columnNames: COLS,
    columnUnits: ['UTC', 'degrees_north', 'degrees_east',
      'cells/L', 'cells/L', 'cells/L', 'cells/L', 'cells/L',
      'cells/L', 'cells/L', 'cells/L', 'cells/L', 'cells/L',
      'ng/mL', 'ng/mL', 'ng/mL', 'degree_C', null, 'cells/L'],
    rows: [
      ['2026-09-21T22:00:00Z', 34.008, -118.499, 748, 0, 374, 0, 0, 0, 0, null, null, 0, null, null, null, 24.2, null, 4488],
      ['2026-09-28T19:00:00Z', 34.008, -118.499, 1870, 0, 0, 0, 0, 0, 0, null, null, 1496, null, null, null, 24, null, 11968],
    ],
  },
};

const SM = STATIONS.find((s) => s.id === 'santamonica');

test('numOrNull guards the Number(null)/Number("")===0 trap', () => {
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull('   '), null);
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull(0), 0); // real lab zero is preserved, not nulled
  assert.equal(numOrNull('1870'), 1870);
});

test('taxonAlert applies C-HARM thresholds exactly', () => {
  assert.equal(BLOOM_CELLS_PER_L, 10_000);
  assert.equal(PDA_ALERT_NG_PER_ML, 0.5); // 500 ng/L published, in ng/mL
  assert.equal(taxonAlert(null), 'nodata');
  assert.equal(taxonAlert(0), 'background');
  assert.equal(taxonAlert(9_999), 'present');
  assert.equal(taxonAlert(10_000), 'bloom'); // boundary inclusive
  assert.equal(taxonAlert(1_000_000), 'bloom');
});

test('parseStationPayload on real Santa Monica bytes', () => {
  // nowMs pinned 2026-10-01T12:00Z → sample age 2.7 days, fresh.
  const row = parseStationPayload(SANTA_MONICA_FIXTURE, SM, Date.parse('2026-10-01T12:00:00Z'));
  assert.equal(row.ok, true);
  assert.equal(row.id, 'santamonica');
  assert.equal(row.name, 'Santa Monica Pier');
  assert.equal(row.lat, 34.008);
  assert.equal(row.lon, -118.499);
  assert.equal(row.latestSample, '2026-09-28T19:00:00Z');
  assert.equal(row.sampleAgeDays, 2.7);
  assert.equal(row.fresh, true);
  assert.equal(row.taxa.Lingulodinium_polyedra, 1870);
  assert.equal(row.taxa.Prorocentrum_spp, 1496);
  assert.equal(row.taxa.Alexandrium_spp, 0);
  assert.equal(row.taxa.Cochlodinium_spp, null); // not analyzed — never zero-filled
  assert.equal(row.taxaAlerts.Lingulodinium_polyedra, 'present'); // 1870 < 10,000
  assert.equal(row.taxaAlerts.Cochlodinium_spp, 'nodata');
  assert.equal(row.taxa.pseudo_nitzschia_combined, 0); // 0 + 0, both known
  assert.equal(row.taxaAlerts.pseudo_nitzschia_combined, 'background');
  assert.equal(row.domoicAcid.pDA, null);
  assert.equal(row.domoicAcid.toxinAlert, false);
  assert.equal(row.tempC, 24);
  assert.equal(row.salinity, null);
  assert.equal(row.totalPhytoplankton, 11968);
  assert.equal(row.alertLevel, 'present');
  assert.ok(row.alertTaxa.includes('Lingulodinium_polyedra'));
  assert.ok(row.alertTaxa.includes('Prorocentrum_spp'));
  assert.equal(row.rowCount, 2);
});

test('parseStationPayload flags bloom at the 10,000 cells/L threshold', () => {
  const f = JSON.parse(JSON.stringify(SANTA_MONICA_FIXTURE));
  const li = COLS.indexOf('Lingulodinium_polyedra');
  f.table.rows[1][li] = 25_000; // red-tide bloom in latest row
  const row = parseStationPayload(f, SM, Date.parse('2026-10-01T12:00:00Z'));
  assert.equal(row.taxaAlerts.Lingulodinium_polyedra, 'bloom');
  assert.equal(row.alertLevel, 'bloom');
});

test('parseStationPayload flags domoic-acid toxin alert at 0.5 ng/mL', () => {
  const f = JSON.parse(JSON.stringify(SANTA_MONICA_FIXTURE));
  const pi = COLS.indexOf('pDA');
  f.table.rows[1][pi] = 0.75; // ≥ 0.5 ng/mL (= 500 ng/L C-HARM)
  const row = parseStationPayload(f, SM, Date.parse('2026-10-01T12:00:00Z'));
  assert.equal(row.domoicAcid.toxinAlert, true);
  assert.equal(row.alertLevel, 'toxin-alert'); // no bloom, toxin wins over present
});

test('parseStationPayload keeps pseudo-nitzschia null when both groups unanalyzed', () => {
  const f = JSON.parse(JSON.stringify(SANTA_MONICA_FIXTURE));
  f.table.rows[1][COLS.indexOf('Pseudo_nitzschia_delicatissima_group')] = null;
  f.table.rows[1][COLS.indexOf('Pseudo_nitzschia_seriata_group')] = null;
  const row = parseStationPayload(f, SM, Date.parse('2026-10-01T12:00:00Z'));
  assert.equal(row.taxa.pseudo_nitzschia_combined, null); // not 0 — never zero-filled
  assert.equal(row.taxaAlerts.pseudo_nitzschia_combined, 'nodata');
});

test('parseStationPayload marks stale samples not fresh', () => {
  const row = parseStationPayload(SANTA_MONICA_FIXTURE, SM, Date.parse('2026-11-30T12:00:00Z'));
  assert.equal(row.fresh, false);
  assert.ok(row.sampleAgeDays > 21);
});

test('parseStationPayload throws 502 on bad shapes, never fabricates', () => {
  assert.throws(() => parseStationPayload({}, SM), /hab_invalid_payload/);
  assert.throws(
    () => parseStationPayload({ table: { columnNames: COLS, rows: [] } }, SM),
    /empty rows/,
  );
  const short = JSON.parse(JSON.stringify(SANTA_MONICA_FIXTURE));
  short.table.columnNames = short.table.columnNames.filter((c) => c !== 'pDA');
  assert.throws(() => parseStationPayload(short, SM), /missing column pDA/);
});

test('parseQuery: all / station / notfound / bad', () => {
  const q = (s) => new URLSearchParams(s);
  assert.deepEqual(parseQuery(q('')), { mode: 'all' });
  const st = parseQuery(q('station=santamonica'));
  assert.equal(st.mode, 'station');
  assert.equal(st.station.id, 'santamonica');
  const nf = parseQuery(q('station=atlantis'));
  assert.deepEqual(nf, { mode: 'notfound', station: 'atlantis' });
  assert.throws(() => parseQuery(q('station=BAD!')), /hab_bad_station/);
  assert.deepEqual(parseQuery(q('station=')), { mode: 'all' }); // empty = all
});

test('selectionStations + buildUpstreamUrl', () => {
  assert.equal(selectionStations({ mode: 'all' }).length, STATIONS.length);
  assert.equal(selectionStations({ mode: 'station', station: SM })[0].id, 'santamonica');
  const url = buildUpstreamUrl(SM, '2026-07-03T00:00:00.000Z');
  assert.ok(url.includes('HABs-SantaMonicaPier.json'));
  assert.ok(url.includes('Lingulodinium_polyedra'));
  assert.ok(url.includes('pDA'));
  assert.ok(url.includes('orderBy'));
});

test('buildPayload envelope carries honesty blocks', () => {
  const row = parseStationPayload(SANTA_MONICA_FIXTURE, SM, Date.parse('2026-10-01T12:00:00Z'));
  const p = buildPayload([row], false);
  assert.equal(p.stale, false);
  assert.ok(p.source.includes('CalHABMAP'));
  assert.equal(p.thresholds.bloomCellsPerL, 10_000);
  assert.equal(p.thresholds.pdaAlertNgPerMl, 0.5);
  assert.equal(p.stations.length, 1);
  assert.ok(p.honesty.background.includes('latest weekly sample'));
});

test('9 stations pinned, all well-formed', () => {
  assert.equal(STATIONS.length, 9);
  const ids = STATIONS.map((s) => s.id);
  assert.equal(new Set(ids).size, 9);
  for (const s of STATIONS) {
    assert.match(s.dataset, /^HABs-/);
    assert.ok(s.name && s.region);
  }
  assert.ok(_habInternals.clearCaches, 'internals exported');
});
