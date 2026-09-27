import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuoysLayer } from './index.js';
import { createBuoySource } from './source.js';
import { parseBuoyStationsXml, MAX_BUOY_STATIONS } from './records.js';
import { selectBuoyOverlayCohort } from './model.js';

const xml = (stations) =>
  `<?xml version="1.0"?><stations created="2026-09-26T23:40:03UTC" count="${stations.length}">` +
  stations
    .map(
      (s) =>
        `<station id="${s.id}" lat="${s.lat}" lon="${s.lon}" name="${s.name}" type="${s.type || 'buoy'}" />`,
    )
    .join('') +
  '</stations>';

test('parseBuoyStationsXml reads station attributes', () => {
  const rows = parseBuoyStationsXml(
    xml([
      { id: '41001', lat: 34.7, lon: -72.7, name: 'East Hatteras' },
      { id: '46050', lat: 44.6, lon: -124.5, name: 'Stonewall Bank', type: 'moored buoy' },
    ]),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].stableId, '41001');
  assert.equal(rows[1].type, 'moored buoy');
  assert.equal(rows[1].lat, 44.6);
});

test('parseBuoyStationsXml rejects malformed XML and bad coordinates', () => {
  assert.equal(parseBuoyStationsXml(''), null);
  assert.equal(parseBuoyStationsXml('<html></html>'), null);
  assert.equal(
    parseBuoyStationsXml(xml([{ id: 'x', lat: 999, lon: 0, name: 'bad' }])),
    null,
  );
  const dupes = parseBuoyStationsXml(
    xml([
      { id: '41001', lat: 34.7, lon: -72.7, name: 'a' },
      { id: '41001', lat: 34.7, lon: -72.7, name: 'b' },
    ]),
  );
  assert.equal(dupes.length, 1);
});

test('parseBuoyStationsXml caps the station count', () => {
  const many = [];
  for (let i = 0; i < MAX_BUOY_STATIONS + 50; i++) {
    many.push({ id: `s${i}`, lat: 10 + (i % 60), lon: -20 - (i % 100), name: `n${i}` });
  }
  const rows = parseBuoyStationsXml(xml(many));
  assert.equal(rows.length, MAX_BUOY_STATIONS);
});

test('selectBuoyOverlayCohort samples deterministically', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));
  const cohort = selectBuoyOverlayCohort(entries, 4);
  assert.equal(cohort.length, 4);
  assert.deepEqual(cohort.map((e) => e.id), ['0', '2', '5', '7']);
});

test('source throws on HTTP errors and empty feeds', async () => {
  const bad = createBuoySource({
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  await assert.rejects(bad.getSnapshot(), /502/);
  const empty = createBuoySource({
    fetchImpl: async () => ({ ok: true, text: async () => '<stations></stations>' }),
  });
  await assert.rejects(empty.getSnapshot(), /Malformed/);
});

function harness(source) {
  const sources = [];
  const events = [];
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createBuoysLayer({
    source,
    overlayHost: {
      setEntries(...args) {
        events.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, events };
}

test('layer renders stations and recovers from upstream failure', async () => {
  const rows = parseBuoyStationsXml(
    xml([{ id: '41001', lat: 34.7, lon: -72.7, name: 'East Hatteras' }]),
  );
  const h = harness({ getSnapshot: async () => rows });
  assert.equal(await h.layer.update(h.viewer), true);
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.events.length, 1);
  const records = h.layer.getAnalystRecords();
  assert.equal(records[0].stationId, '41001');
  h.layer.destroy(h.viewer);
  assert.equal(h.sources.length, 0);

  const failing = harness({
    getSnapshot: async () => {
      throw new Error('xml down');
    },
  });
  assert.equal(await failing.layer.update(failing.viewer), false);
  assert.match(failing.layer.getStats().error, /xml down/);
});
