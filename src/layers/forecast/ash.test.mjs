import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseVaacCoordinate,
  parseVaacDtg,
  parseVaacCloudPolygon,
  parseVaacAdvisoryText,
  parseVaacAdvisoryList,
  latestAdvisoryPerVolcano,
  createVaacSource,
  ashAdvisoryEntities,
} from './ash.js';

// Real advisory shape captured from Tokyo VAAC 2026-08-02 (Sakurajima) —
// values trimmed to a fixture, format verbatim.
const SAKURAJIMA_TEXT =
  'FVFE01 RJTD 021531 VA ADVISORY DTG: 20260802/1531Z VAAC: TOKYO ' +
  'VOLCANO: SAKURAJIMA (AIRA CALDERA) 282080 PSN: N3136 E13039 AREA: JAPAN ' +
  'SUMMIT ELEV: 1117M ADVISORY NR: 2026/136 INFO SOURCE: HIMAWARI-9 ' +
  'ERUPTION DETAILS: EXPLODED AT 20260802/1434Z FL140 OBS VA DTG: 02/1510Z ' +
  'OBS VA CLD: SFC/FL140 N3135 E13043 - N3129 E13034 - N3136 E13031 - N3139 E13041 ' +
  'MOV SW 15KT FCST VA CLD +6 HR: 02/2110Z SFC/FL150 N3103 E13006 - N3028 E13006 - ' +
  'N3032 E12851 - N3052 E12859 FCST VA CLD +12 HR: 03/0310Z SFC/FL140 N2929 E12926 - ' +
  'N2846 E12907 - N2919 E12726 - N2951 E12738 - N2953 E12907 FCST VA CLD +18 HR: ' +
  'NO VA EXP RMK: NIL NXT ADVISORY: 20260802/1800Z=';

const LIST_HTML =
  '<tr id="tr0"> 2026/09/26 23:50:00 23:50 UTC, 26 Sep. 2026 SHEVELUCH RUSSIA ' +
  '2026/343 <a href="TextData/2026/20260926_30027000_0343_Text.html">Text</a></tr>' +
  '<tr id="tr1"> 2026/09/26 18:00:00 18:00 UTC, 26 Sep. 2026 SHEVELUCH RUSSIA ' +
  '2026/342 <a href="TextData/2026/20260926_30027000_0342_Text.html">Text</a></tr>' +
  '<tr id="tr2"> 2026/09/26 15:31:00 15:31 UTC, 26 Sep. 2026 MAYON PHILIPPINES ' +
  '2026/797 <a href="TextData/2026/20260926_27303000_0797_Text.html">Text</a></tr>';

test('parseVaacCoordinate handles ICAO lat/lon tokens incl. tenths', () => {
  assert.equal(parseVaacCoordinate('N3136'), 31 + 36 / 60);
  assert.equal(parseVaacCoordinate('E13039'), 130 + 39 / 60);
  assert.equal(parseVaacCoordinate('S1225'), -(12 + 25 / 60));
  assert.equal(parseVaacCoordinate('W15642'), -(156 + 42 / 60));
  assert.ok(Math.abs(parseVaacCoordinate('N3116.5') - (31 + 16.5 / 60)) < 1e-9);
  assert.equal(parseVaacCoordinate('bogus'), null);
  assert.equal(parseVaacCoordinate('N3199'), null, 'minutes >= 60 rejected');
});

test('parseVaacDtg converts advisory DTGs to UTC ms', () => {
  assert.equal(parseVaacDtg('20260802/1531Z'), Date.UTC(2026, 7, 2, 15, 31));
  assert.equal(parseVaacDtg('nope'), null);
});

test('parseVaacCloudPolygon builds closed lon/lat rings', () => {
  const ring = parseVaacCloudPolygon('N3135 E13043 - N3129 E13034 - N3136 E13031');
  assert.equal(ring.length, 4);
  assert.deepEqual(ring[0], ring.at(-1), 'closed');
  assert.ok(ring[0][0] > 130 && ring[0][0] < 131, 'lon first (GeoJSON order)');
  assert.equal(parseVaacCloudPolygon('N3135 E13043'), null, 'too few points');
  assert.equal(parseVaacCloudPolygon('N3135 BOGUS'), null);
});

test('parseVaacAdvisoryText parses a real-format advisory', () => {
  const a = parseVaacAdvisoryText(SAKURAJIMA_TEXT);
  assert.ok(a, 'parses');
  assert.equal(a.volcano, 'SAKURAJIMA (AIRA CALDERA)');
  assert.equal(a.volcanoId, '282080');
  assert.equal(a.advisoryNumber, '2026/136');
  assert.equal(a.dtgMs, Date.UTC(2026, 7, 2, 15, 31));
  assert.ok(Math.abs(a.summit.lat - (31 + 36 / 60)) < 1e-9);
  assert.ok(Math.abs(a.summit.lon - (130 + 39 / 60)) < 1e-9);
  assert.equal(a.area, 'JAPAN');
  const kinds = a.clouds.map((c) => `${c.kind}:${c.tauHours}`);
  assert.deepEqual(kinds, ['observed:0', 'forecast:6', 'forecast:12']);
  const obs = a.clouds[0];
  assert.equal(obs.levels, 'SFC/FL140');
  assert.equal(obs.polygon.length, 5, '4-point polygon closed');
  assert.deepEqual(obs.movement, { fromCompass: 'SW', speedKt: 15 });
  const fc6 = a.clouds[1];
  assert.equal(fc6.levels, 'SFC/FL150');
  assert.equal(fc6.dtgMs, Date.UTC(2026, 7, 2, 21, 10));
  assert.equal(a.nextAdvisoryMs, Date.UTC(2026, 7, 2, 18, 0));
});

test('parseVaacAdvisoryText returns null on garbage, never fabricates', () => {
  assert.equal(parseVaacAdvisoryText(''), null);
  assert.equal(parseVaacAdvisoryText('no advisory here at all, just words '.repeat(10)), null);
  assert.equal(parseVaacAdvisoryText('DTG: 20260802/1531Z VOLCANO: FOO'), null);
});

test('parseVaacAdvisoryList extracts latest-first rows with absolute URLs', () => {
  const rows = parseVaacAdvisoryList(LIST_HTML);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].volcano, 'SHEVELUCH');
  assert.equal(rows[0].country, 'RUSSIA');
  assert.equal(rows[0].advisoryNumber, '2026/343');
  assert.equal(rows[0].issuedAtMs, Date.UTC(2026, 8, 26, 23, 50));
  assert.ok(rows[0].href.startsWith('https://ds.data.jma.go.jp/svd/vaac/data/TextData/'));
});

test('latestAdvisoryPerVolcano dedupes to the newest advisory', () => {
  const rows = parseVaacAdvisoryList(LIST_HTML);
  const latest = latestAdvisoryPerVolcano(rows);
  assert.equal(latest.length, 2);
  assert.equal(latest[0].volcano, 'SHEVELUCH');
  assert.equal(latest[0].advisoryNumber, '2026/343');
  assert.equal(latest[1].volcano, 'MAYON');
});

test('createVaacSource degrades honestly when the feed is down', async () => {
  const source = createVaacSource({
    fetchImpl: async () => ({ ok: false, status: 502, body: null }),
  });
  const snap = await source.getSnapshot({});
  assert.equal(snap.unavailable, true);
  assert.deepEqual(snap.advisories, []);
  assert.ok(snap.reason.includes('502'), 'reason names the failure');
});

test('createVaacSource parses list + advisory bodies end to end', async () => {
  const fetchImpl = async (url) => {
    if (url === '/api/vaac') return { ok: true, body: null, text: async () => LIST_HTML };
    if (url.includes('0343')) return { ok: true, body: null, text: async () => SAKURAJIMA_TEXT };
    return { ok: false, status: 404, body: null };
  };
  const source = createVaacSource({ fetchImpl, listBaseUrl: 'https://x/vaac-base/' });
  const snap = await source.getSnapshot({});
  assert.equal(snap.unavailable, false);
  assert.equal(snap.advisories.length, 1, 'only the parseable advisory survives');
  assert.equal(snap.advisories[0].volcano, 'SAKURAJIMA (AIRA CALDERA)');
  assert.equal(snap.advisories[0].country, 'RUSSIA', 'country carried from the list row');
});

test('ashAdvisoryEntities emits cloud polygons + one label entity', () => {
  const a = parseVaacAdvisoryText(SAKURAJIMA_TEXT);
  const entities = ashAdvisoryEntities(a);
  assert.equal(entities.length, 4, '3 cloud polygons + 1 label');
  const label = entities.at(-1);
  assert.ok(label.id.endsWith(':label'));
  assert.ok(label.label.text.getValue().includes('SAKURAJIMA'));
});
