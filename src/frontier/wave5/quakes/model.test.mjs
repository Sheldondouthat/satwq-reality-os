import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchQuakes,
  magColor,
  magSize,
  depthBand,
  quakeLabel,
  quakeAge,
  sourcesSummary,
  sortQuakesByMag,
  escapeHtml,
} from './model.js';

const SAMPLE_PAYLOAD = {
  generatedAt: '2026-09-27T20:00:00.000Z',
  sources: {
    usgs: { ok: true, count: 2, attribution: 'USGS' },
    jma: { ok: true, count: 1, attribution: 'JMA' },
    bmkg: { ok: false, count: 0, attribution: 'BMKG', error: 'timeout' },
    geonet: { ok: true, count: 1, attribution: 'GeoNet' },
    emsc: { ok: true, count: 1, attribution: 'EMSC' },
  },
  count: 5,
  quakes: [
    { id: 'usgs:a', lat: 60.2, lon: -150.5, depthKm: 33, mag: 6.5, place: 'Southern Alaska', time: '2026-09-27T18:00:00.000Z', sources: ['usgs', 'emsc'] },
    { id: 'jma:b', lat: 32.8, lon: 130.8, depthKm: 10, mag: 4.5, place: 'Kumamoto', time: '2026-09-27T19:00:00.000Z', sources: ['jma'] },
  ],
};

test('magColor ramps green→magenta across magnitude bands', () => {
  assert.equal(magColor(3.2), '#4dd07d');
  assert.equal(magColor(4.9), '#ffd54d');
  assert.equal(magColor(5.5), '#ff9f43');
  assert.equal(magColor(6.8), '#ff5a5a');
  assert.equal(magColor(7.5), '#c44dff');
  assert.equal(magColor(null), '#8a93a6');
  assert.equal(magColor(4), '#ffd54d'); // boundary: 4.0 is yellow band
});

test('magSize grows with magnitude and clamps', () => {
  assert.equal(magSize(3), 6);
  assert.ok(magSize(6) > magSize(4));
  assert.equal(magSize(12), 26);
  assert.equal(magSize(NaN), 6);
});

test('depthBand classifies depth bands', () => {
  assert.equal(depthBand(33), 'shallow (<70 km)');
  assert.equal(depthBand(150), 'intermediate (70–300 km)');
  assert.equal(depthBand(500), 'deep (>300 km)');
  assert.equal(depthBand(null), 'unknown');
});

test('quakeLabel formats magnitude and truncates long places', () => {
  assert.equal(quakeLabel(SAMPLE_PAYLOAD.quakes[0]), 'M6.5 · Southern Alaska');
  assert.equal(quakeLabel({ mag: null, place: '' }), 'M?');
  assert.ok(quakeLabel({ mag: 5, place: 'x'.repeat(300) }).length <= 120);
});

test('quakeAge renders relative age', () => {
  const now = Date.parse('2026-09-27T20:00:00.000Z');
  assert.equal(quakeAge('2026-09-27T19:50:00.000Z', now), '10m ago');
  assert.equal(quakeAge('2026-09-27T17:00:00.000Z', now), '3h ago');
  assert.equal(quakeAge('2026-09-25T20:00:00.000Z', now), '2d ago');
  assert.equal(quakeAge('not-a-time', now), 'age n/a');
});

test('sourcesSummary joins attribution labels', () => {
  assert.equal(sourcesSummary(['usgs', 'emsc']), 'USGS + EMSC');
  assert.equal(sourcesSummary([]), 'unknown source');
  assert.equal(sourcesSummary(['zzz']), 'zzz');
});

test('sortQuakesByMag orders by magnitude then recency', () => {
  const sorted = sortQuakesByMag(SAMPLE_PAYLOAD.quakes);
  assert.equal(sorted[0].id, 'usgs:a');
  assert.equal(sorted[1].id, 'jma:b');
});

test('escapeHtml neutralizes markup', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('fetchQuakes returns parsed payload with fetchImpl', async () => {
  const fetchImpl = async () => new Response(JSON.stringify(SAMPLE_PAYLOAD), { status: 200 });
  const payload = await fetchQuakes({ fetchImpl });
  assert.equal(payload.count, 5);
  assert.equal(payload.sources.bmkg.ok, false);
  assert.equal(payload.sources.bmkg.error, 'timeout');
});

test('fetchQuakes throws on HTTP error and on bad payload', async () => {
  const bad = async () => new Response('down', { status: 503 });
  await assert.rejects(() => fetchQuakes({ fetchImpl: bad }), /quakes_http_503/);
  const wrong = async () => new Response(JSON.stringify({ nope: true }), { status: 200 });
  await assert.rejects(() => fetchQuakes({ fetchImpl: wrong }), /quakes_bad_payload/);
});
