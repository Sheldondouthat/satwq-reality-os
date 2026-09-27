/**
 * socrates provider tests — REAL assertions on CSV parsing.
 * Column names follow CelesTrak's SOCRATES Plus format documentation
 * (verified 2026-09-27): TCA (UTC), NORAD Catalog Number ×2, Name ×2
 * (ops status in brackets), Days Since Epoch ×2, Min Range (km),
 * Relative Speed (km/sec), Max Probability.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  socratesProxy,
  splitCsvLine,
  mapSocratesColumns,
  parseSocratesCsv,
  scanLines,
  normalizeConjunctionRow,
  parseTca,
  splitOpsStatus,
  parseTleSet,
} from './socrates.js';

const HEADER =
  'TCA (UTC),NORAD Catalog Number,NORAD Catalog Number,Name,Name,' +
  'Days Since Epoch,Days Since Epoch,Min Range (km),Relative Speed (km/sec),Max Probability';
const ROW =
  '2026-09-28 14:22:10,25544,48274,"ISS (ZARYA) [+]",TIANHE,"1.2","0.8",0.42,11.3,2.5e-05';

test('splitCsvLine handles RFC 4180 quoting', () => {
  const cells = splitCsvLine('a,"b,c","d""e",f');
  assert.deepEqual(cells, ['a', 'b,c', 'd"e', 'f']);
});

test('mapSocratesColumns maps the documented header', () => {
  const col = mapSocratesColumns(splitCsvLine(HEADER));
  assert.ok(col, 'header must map');
  assert.equal(col.tca, 0);
  assert.equal(col.norad1, 1);
  assert.equal(col.norad2, 2);
  assert.equal(col.name1, 3);
  assert.equal(col.name2, 4);
  assert.equal(col.dse1, 5);
  assert.equal(col.dse2, 6);
  assert.equal(col.minRangeKm, 7);
  assert.equal(col.relSpeedKms, 8);
  assert.equal(col.maxProb, 9);
});

test('mapSocratesColumns returns null on format drift', () => {
  assert.equal(mapSocratesColumns(['foo', 'bar']), null);
});

// OBSERVED live 2026-09-27: the real sort-minRange.csv uses the MACHINE
// header family. This test pins that exact header + a real row so a future
// CelesTrak format change fails loudly instead of 502ing in production.
const MACHINE_HEADER =
  'NORAD_CAT_ID_1,OBJECT_NAME_1,DSE_1,NORAD_CAT_ID_2,OBJECT_NAME_2,DSE_2,' +
  'TCA,TCA_RANGE,TCA_RELATIVE_SPEED,MAX_PROB,DILUTION';
const MACHINE_ROW =
  '100753,STARLINK-38381 [+],7.838,100759,STARLINK-38399 [+],7.838,' +
  '2026-09-27 22:46:51.724,0.003,0.000,1.000E+00,0.000';

test('mapSocratesColumns maps the live machine header (2026-09-27)', () => {
  const col = mapSocratesColumns(splitCsvLine(MACHINE_HEADER));
  assert.ok(col, 'live header must map');
  assert.deepEqual(
    [col.norad1, col.name1, col.dse1, col.norad2, col.name2, col.dse2,
     col.tca, col.minRangeKm, col.relSpeedKms, col.maxProb],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test('normalizeConjunctionRow converts a live machine row exactly', () => {
  const col = mapSocratesColumns(splitCsvLine(MACHINE_HEADER));
  const ev = normalizeConjunctionRow(splitCsvLine(MACHINE_ROW), col);
  assert.equal(ev.tcaUtc, '2026-09-27T22:46:51.000Z');
  assert.equal(ev.noradId1, '100753');
  assert.equal(ev.noradId2, '100759');
  assert.equal(ev.name1, 'STARLINK-38381');
  assert.equal(ev.ops1, '+');
  assert.equal(ev.name2, 'STARLINK-38399');
  assert.equal(ev.minRangeKm, 0.003);
  assert.equal(ev.maxProb, 1);
  assert.equal(ev.dse1, 7.838);
  assert.equal(ev.relSpeedKms, 0);
});

test('scanLines yields lazily without materializing the whole file', () => {
  const text = 'a\nb\nc';
  assert.deepEqual([...scanLines(text)], ['a', 'b', 'c']);
  const gen = scanLines('x\ny');
  assert.equal(gen.next().value, 'x'); // lazy: no full split needed
});

test('parseSocratesCsv parses the production path end-to-end (regression)', () => {
  // The 2026-09-27 near-miss: a "find header, break, keep scanning" loop
  // over the generator silently yielded ZERO rows (for...of break closes
  // generators via IteratorClose). This test drives the exact function
  // getEvents() uses, on realistic multi-line input.
  const text = [
    MACHINE_HEADER,
    '',
    MACHINE_ROW,
    MACHINE_ROW.replace('100753', '100754').replace('STARLINK-38381', 'STARLINK-38382'),
    'garbage,row,here',
  ].join('\r\n');
  const events = parseSocratesCsv(text, 40);
  assert.equal(events.length, 2);
  assert.equal(events[0].noradId1, '100753');
  assert.equal(events[1].name1, 'STARLINK-38382');
  assert.throws(() => parseSocratesCsv('', 40), /socrates_upstream_empty/);
  assert.throws(
    () => parseSocratesCsv('foo,bar\n1,2', 40),
    /socrates_header_drift/,
  );
  assert.throws(
    () => parseSocratesCsv(`${MACHINE_HEADER}\n9.9,9.9,9.9,9.9,9.9,9.9,9.9,9.9,9.9,9.9,9.9`, 40),
    /socrates_upstream_unparseable/,
  );
});

test('normalizeConjunctionRow converts a documented row exactly', () => {
  const col = mapSocratesColumns(splitCsvLine(HEADER));
  const ev = normalizeConjunctionRow(splitCsvLine(ROW), col);
  assert.equal(ev.tcaUtc, '2026-09-28T14:22:10.000Z');
  assert.equal(ev.noradId1, '25544');
  assert.equal(ev.noradId2, '48274');
  assert.equal(ev.name1, 'ISS (ZARYA)');
  assert.equal(ev.ops1, '+');
  assert.equal(ev.name2, 'TIANHE');
  assert.equal(ev.minRangeKm, 0.42);
  assert.equal(ev.relSpeedKms, 11.3);
  assert.equal(ev.maxProb, 2.5e-05);
  assert.equal(ev.dse1, 1.2);
});

test('normalizeConjunctionRow drops rows outside the 5 km wall', () => {
  const col = mapSocratesColumns(splitCsvLine(HEADER));
  const far = splitCsvLine(ROW.replace('0.42', '7.9'));
  assert.equal(normalizeConjunctionRow(far, col), null);
});

test('parseTca / splitOpsStatus edge cases', () => {
  assert.equal(parseTca('garbage'), null);
  assert.equal(parseTca(null), null);
  assert.deepEqual(splitOpsStatus('STARLINK-1234 [+]'), { name: 'STARLINK-1234', ops: '+' });
  assert.deepEqual(splitOpsStatus('COSMOS 2251'), { name: 'COSMOS 2251', ops: null });
});

test('parseTleSet extracts a 3-line set', () => {
  const text = 'ISS (ZARYA)\n1 25544U 98067A   26270.5  .0001  00000-0  00000-0 0  9990\n2 25544  51.6 208.9 0006 130.5 325.0 15.5 00000000';
  const tle = parseTleSet(text);
  assert.ok(tle);
  assert.ok(tle.line1.startsWith('1 25544'));
  assert.ok(tle.line2.startsWith('2 25544'));
  assert.equal(parseTleSet('<html>nope</html>'), null);
});

test('socratesProxy mounts /api/conjunctions on both server shapes', () => {
  const provider = socratesProxy();
  assert.equal(provider.name, 'socrates');
  const seen = [];
  const middlewares = { use: (route) => seen.push(route) };
  provider.configureServer({ middlewares });
  provider.configurePreviewServer({ middlewares });
  assert.deepEqual(seen, ['/api/conjunctions', '/api/conjunctions']);
});

function fakeReq(url, method = 'GET') {
  return { method, url, on: () => {}, removeListener: () => {}, headers: {} };
}
function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null, headers: {},
    writeHead(s, h) { res.statusCode = s; res.headers = h; },
    end(b) { chunks.push(b); res.body = chunks.join(''); },
  };
  return res;
}

test('socratesProxy rejects non-GET with 405 without touching upstream', async () => {
  const provider = socratesProxy();
  const calls = [];
  provider.configureServer({ middlewares: { use: (r, h) => calls.push({ r, h }) } });
  const res = fakeRes();
  await calls[0].h(fakeReq('/api/conjunctions', 'POST'), res);
  assert.equal(res.statusCode, 405);
  assert.match(res.body, /method_not_allowed/);
});
