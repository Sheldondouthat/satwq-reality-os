import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchWxStations,
  kindNote,
  markerSize,
  normalizeStations,
  stationLabel,
  summarizeSources,
  tempColor,
} from './model.js';

test('tempColor ramps blue -> green -> amber -> red', () => {
  assert.equal(tempColor(-5), '#4da6ff');
  assert.equal(tempColor(5), '#37c8ab');
  assert.equal(tempColor(15), '#a3d65c');
  assert.equal(tempColor(25), '#ffb454');
  assert.equal(tempColor(35), '#ff5a5a');
  assert.equal(tempColor(null), '#8a93a6');
  assert.equal(tempColor(NaN), '#8a93a6');
});

test('markerSize grows with wind and is bounded', () => {
  assert.equal(markerSize(null), 8);
  assert.equal(markerSize(0), 8);
  assert.ok(markerSize(5) > 8);
  assert.equal(markerSize(100), 14); // capped
});

test('stationLabel formats temp and wind, honest empty', () => {
  assert.equal(stationLabel({ tempC: 12.345, windMs: 3.14159 }), '12.3°C · 3.1 m/s');
  assert.equal(stationLabel({ tempC: null, windMs: null }), '—');
});

test('kindNote labels forecast and station-index honestly', () => {
  assert.equal(kindNote('obs'), 'observed');
  assert.equal(kindNote('forecast'), 'forecast, not observed');
  assert.equal(kindNote('station-index'), 'location only — no temperature');
});

test('normalizeStations drops coord-less rows and sorts obs first', () => {
  const rows = normalizeStations([
    { id: 'a', lat: 1, lon: 2, kind: 'station-index' },
    { id: 'b', lat: null, lon: 2, kind: 'obs' },
    { id: 'c', lat: 3, lon: 4, kind: 'obs' },
    { id: 'd', lat: 5, lon: 6, kind: 'forecast' },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['c', 'd', 'a']);
});

test('fetchWxStations validates shape', async () => {
  const good = async () => ({
    ok: true,
    json: async () => ({
      generatedAt: 'x', stale: false, unavailable: false, reason: null,
      sources: [{ id: 'nws', name: 'NWS', kind: 'obs', status: 'ok', count: 1 }],
      stations: [{ source: 'nws', id: 'KROA', lat: 37, lon: -80, tempC: 20, kind: 'obs' }],
    }),
  });
  const doc = await fetchWxStations(good);
  assert.equal(doc.stations.length, 1);
  assert.equal(doc.sources.length, 1);

  const badShape = async () => ({ ok: true, json: async () => ({}) });
  await assert.rejects(() => fetchWxStations(badShape), /unexpected_shape/);

  const httpFail = async () => ({ ok: false, status: 502 });
  await assert.rejects(() => fetchWxStations(httpFail), /wxstations_http_502/);
});

test('summarizeSources trims to the fields the dock needs', () => {
  const out = summarizeSources([{ id: 'nws', name: 'NWS', kind: 'obs', status: 'ok', count: 4, stations: [1, 2] }]);
  assert.deepEqual(out, [{ id: 'nws', name: 'NWS', kind: 'obs', status: 'ok', count: 4 }]);
});
