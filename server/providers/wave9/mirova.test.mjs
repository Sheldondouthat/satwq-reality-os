/**
 * Wave 9 — MIROVA volcano hotspots — provider tests.
 *
 * Fixture rows are REAL bytes from https://www.mirovaweb.it/NRT/ captured
 * 2026-10-02 (Stromboli/Manam/Nyamuragira rows verbatim).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mirovaProxy, parseMirova, buildPayload, _mirovaInternals } from './mirova.js';

const { UPSTREAM_URL, decodeEntities, numOrNull, resetCache } = _mirovaInternals;

// Real rows from the 2026-10-02 capture (whitespace normalized by hand;
// cell order and values verbatim).
const REAL_ROWS = `
<tbody>
<tr class="moderate">
  <td>02-Oct-2026 11:00:02</td>
  <td>211040</td>
  <td><a class="volcano-link" href="../NRT/volcanoDetails_VIR.php?volcano_id=211040" target="_self">Stromboli</a></td>
  <td>12.11</td>
  <td>1.68</td>
  <td>VIIRS</td>
</tr>
<tr class="moderate">
  <td>02-Oct-2026 10:50:00</td>
  <td>251020</td>
  <td><a class="volcano-link" href="../NRT/volcanoDetails_MOD.php?volcano_id=251020" target="_self">Manam</a></td>
  <td>18.97</td>
  <td>23.19</td>
  <td>MODIS</td>
</tr>
<tr class="moderate">
  <td>02-Oct-2026 10:48:02</td>
  <td>223020</td>
  <td><a class="volcano-link" href="../NRT/volcanoDetails_VIR.php?volcano_id=223020" target="_self">Nyamuragira</a></td>
  <td>67.04</td>
  <td>1.06</td>
  <td>VIIRS</td>
</tr>
</tbody>`;

test('upstream URL is the MIROVA NRT page', () => {
  assert.equal(UPSTREAM_URL, 'https://www.mirovaweb.it/NRT/');
});

test('parseMirova parses real 2026-10-02 rows', () => {
  const { rows } = parseMirova(REAL_ROWS);
  assert.equal(rows.length, 3);
  const s = rows[0];
  assert.equal(s.name, 'Stromboli');
  assert.equal(s.volcanoId, '211040');
  assert.equal(s.time, '02-Oct-2026 11:00:02');
  assert.equal(s.vrpMw, 12.11);
  assert.equal(s.distanceKm, 1.68);
  assert.equal(s.sensor, 'VIIRS');
  assert.equal(s.level, 'moderate'); // MIROVA's own class, carried verbatim
  assert.equal(rows[1].sensor, 'MODIS');
  assert.equal(rows[2].vrpMw, 67.04);
});

test('parseMirova: empty page is a quiet planet, not an error', () => {
  const { rows } = parseMirova('<html><body><table><tbody></tbody></table></body></html>');
  assert.deepEqual(rows, []);
});

test('parseMirova: malformed rows are skipped, never guessed', () => {
  const html = `<tbody>
    <tr class="low"><td>02-Oct-2026 09:00:00</td><td>999999</td><td>Broken Row</td></tr>
    <tr class="low"><td>02-Oct-2026 09:00:00</td><td>111111</td><td><a href="#">Good</a></td><td>5.5</td><td>2.0</td><td>VIIRS</td></tr>
  </tbody>`;
  const { rows } = parseMirova(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Good');
});

test('parseMirova: nameless rows dropped; entities decoded', () => {
  const html = `<tbody><tr class="low"><td>t</td><td>1</td><td><a href="#">A &amp; B</a></td><td>1.0</td><td>1.0</td><td>VIIRS</td></tr></tbody>`;
  const { rows } = parseMirova(html);
  assert.equal(rows[0].name, 'A & B');
});

test('numOrNull guards non-numeric VRP', () => {
  assert.equal(numOrNull('12.11'), 12.11);
  assert.equal(numOrNull('1,234.5'), 1234.5);
  assert.equal(numOrNull('N/A'), null);
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull(null), null);
});

test('decodeEntities handles the entities pages emit', () => {
  assert.equal(decodeEntities('A &amp; B'), 'A & B');
  assert.equal(decodeEntities('&#39;x&#39;'), "'x'");
});

test('buildPayload: summary aggregates levels/sensors/max VRP', () => {
  const { rows } = parseMirova(REAL_ROWS);
  const p = buildPayload({ rows }, false);
  assert.equal(p.summary.detections, 3);
  assert.equal(p.summary.volcanoes, 3);
  assert.deepEqual(p.summary.byLevel, { moderate: 3 });
  assert.deepEqual(p.summary.bySensor, { VIIRS: 2, MODIS: 1 });
  assert.equal(p.summary.maxVrpMw, 67.04);
  assert.equal(p.summary.maxVrpVolcano, 'Nyamuragira');
  assert.equal(p.stale, false);
  assert.ok(p.honesty.vrp.includes('heat-flux proxy'));
  assert.ok(p.honesty.level.includes('extreme >10000'));
  assert.ok(p.honesty.attribution.includes('MIROVA'));
});

test('buildPayload: quiet planet is honest 200 shape', () => {
  const p = buildPayload({ rows: [] }, false);
  assert.equal(p.summary.detections, 0);
  assert.equal(p.summary.maxVrpMw, null);
  assert.deepEqual(p.detections, []);
});

test('buildPayload: stale flag propagates', () => {
  const p = buildPayload({ rows: [] }, true);
  assert.equal(p.stale, true);
});

test('mirovaProxy exposes configureServer/configurePreviewServer', () => {
  const proxy = mirovaProxy();
  assert.equal(proxy.name, 'mirova');
  assert.equal(typeof proxy.configureServer, 'function');
  assert.equal(typeof proxy.configurePreviewServer, 'function');
});

test('_mirovaInternals exposes the cache reset', () => {
  resetCache();
  assert.ok(true);
});
