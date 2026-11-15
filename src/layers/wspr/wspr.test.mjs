import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createWsprLayer } from './index.js';
import { createWsprSource } from './source.js';
import {
  WSPR_ARC_DRAW_CAP,
  arcPeakHeightM,
  arcSegmentCount,
  bandForFreqMHz,
  buildArcDescriptors,
  greatCircleArcPoints,
  greatCircleKm,
  normalizeWsprPayload,
  selectArcCohort,
} from './records.js';
import { arcColor, snrStyle } from './model.js';

const spot = (overrides = {}) => ({
  id: 13651166648,
  time: '2026-11-15T07:16:00.000Z',
  txCall: 'DL2NL',
  txLat: 48.1,
  txLon: 9.2,
  rxCall: 'G4ZFQ',
  rxLat: 51.4,
  rxLon: -0.9,
  freqMHz: 14.0971,
  snrDb: -12,
  drift: 0,
  powerDbm: 37,
  ...overrides,
});

const payload = (spots, overrides = {}) => ({
  generatedAt: '2026-11-15T07:17:38.019Z',
  windowSec: 3600,
  count: spots.length,
  droppedNoCoords: 0,
  spots,
  ...overrides,
});

test('normalizeWsprPayload trims spots and carries envelope state', () => {
  const snap = normalizeWsprPayload(
    payload([spot()], { stale: true, droppedNoCoords: 3 }),
  );
  assert.equal(snap.spots.length, 1);
  assert.equal(snap.spots[0].id, 13651166648);
  assert.equal(snap.spots[0].txCall, 'DL2NL');
  assert.equal(snap.stale, true);
  assert.equal(snap.degraded, false);
  assert.equal(snap.droppedNoCoords, 3);
  assert.equal(snap.generatedAt, '2026-11-15T07:17:38.019Z');
});

test('normalizeWsprPayload rejects error envelopes and non-payloads', () => {
  assert.equal(normalizeWsprPayload({ error: 'wspr_unavailable' }), null);
  assert.equal(normalizeWsprPayload({ generatedAt: 'x' }), null);
  assert.equal(normalizeWsprPayload(null), null);
  assert.equal(normalizeWsprPayload('spots'), null);
});

test('normalizeWsprPayload drops unusable spots and duplicate ids', () => {
  const snap = normalizeWsprPayload(
    payload([
      spot({ id: 1 }),
      spot({ id: 2, txLat: 0, txLon: 0 }), // null island = missing end
      spot({ id: 3, rxLat: 91 }), // out of range
      spot({ id: 4, txLat: 'north' }), // non-numeric
      spot({ id: 1, txCall: 'DUPE' }), // duplicate id: first copy wins
      spot({ id: 5 }),
    ]),
  );
  assert.deepEqual(
    snap.spots.map((s) => s.id),
    [1, 5],
  );
  assert.equal(snap.spots[0].txCall, 'DL2NL');
});

test('bandForFreqMHz maps dial-adjacent frequencies, never guesses', () => {
  assert.equal(bandForFreqMHz(14.0971), '20m');
  assert.equal(bandForFreqMHz(7.0401), '40m');
  assert.equal(bandForFreqMHz(3.5701), '80m');
  assert.equal(bandForFreqMHz(0.1381), '2200m');
  assert.equal(bandForFreqMHz(28.1261), '10m');
  assert.equal(bandForFreqMHz(9.999), 'other');
  assert.equal(bandForFreqMHz(null), 'other');
  assert.equal(bandForFreqMHz(NaN), 'other');
});

test('selectArcCohort passes small sets through and strides large ones', () => {
  const small = [spot({ id: 1 }), spot({ id: 2 })];
  assert.deepEqual(selectArcCohort(small, 600), small);
  const many = Array.from({ length: 1500 }, (_, i) => spot({ id: i + 1 }));
  const cohort = selectArcCohort(many, WSPR_ARC_DRAW_CAP);
  assert.equal(cohort.length, WSPR_ARC_DRAW_CAP);
  assert.equal(cohort[0].id, 1); // stride starts at the newest spot
  assert.ok(cohort[cohort.length - 1].id > 1400); // and reaches the tail
  // Deterministic: the same input yields the same cohort.
  assert.deepEqual(
    selectArcCohort(many, WSPR_ARC_DRAW_CAP).map((s) => s.id),
    cohort.map((s) => s.id),
  );
});

test('great-circle helpers keep endpoints grounded and lift the middle', () => {
  const tx = { lat: 48.1, lon: 9.2 };
  const rx = { lat: 51.4, lon: -0.9 };
  const km = greatCircleKm(tx.lat, tx.lon, rx.lat, rx.lon);
  assert.ok(km > 700 && km < 900);
  const points = greatCircleArcPoints(tx, rx);
  assert.equal(points.length, arcSegmentCount(km) + 1);
  const [firstLon, firstLat, firstH] = points[0];
  assert.ok(Math.abs(firstLon - tx.lon) < 1e-6);
  assert.ok(Math.abs(firstLat - tx.lat) < 1e-6);
  assert.equal(firstH, 0);
  const [lastLon, lastLat, lastH] = points[points.length - 1];
  assert.ok(Math.abs(lastLon - rx.lon) < 1e-6);
  assert.ok(Math.abs(lastLat - rx.lat) < 1e-6);
  assert.equal(lastH, 0);
  const mid = points[Math.floor(points.length / 2)];
  assert.ok(Math.abs(mid[2] - arcPeakHeightM(km)) < 1);
  // Antipodal paths stay finite (no NaNs from the slerp).
  const anti = greatCircleArcPoints({ lat: 0, lon: 10 }, { lat: 0, lon: 190 });
  assert.ok(
    anti.every(([lon, lat, h]) => [lon, lat, h].every(Number.isFinite)),
  );
});

test('buildArcDescriptors retains the wspr.rx id on every arc (§7 join)', () => {
  const built = buildArcDescriptors(
    payload([
      spot({ id: 111, freqMHz: 7.0401, snrDb: -25 }),
      spot({ id: 222, freqMHz: 14.0971, snrDb: -5 }),
    ]),
  );
  assert.equal(built.received, 2);
  assert.equal(built.drawn, 2);
  assert.equal(built.capped, false);
  assert.deepEqual(
    built.arcs.map((a) => a.spotId),
    [111, 222],
  );
  assert.deepEqual(
    built.arcs.map((a) => a.entityId),
    ['wspr-arc:111', 'wspr-arc:222'],
  );
  assert.equal(built.arcs[0].band, '40m');
  assert.equal(built.arcs[1].band, '20m');
  assert.ok(built.arcs.every((a) => a.points.length >= 9));
});

test('buildArcDescriptors reports the draw cap instead of hiding it', () => {
  const many = Array.from({ length: 10 }, (_, i) => spot({ id: i + 1 }));
  const built = buildArcDescriptors(payload(many), { cap: 4 });
  assert.equal(built.received, 10);
  assert.equal(built.drawn, 4);
  assert.equal(built.capped, true);
  assert.equal(buildArcDescriptors({ error: 'wspr_unavailable' }), null);
});

test('snrStyle steps width and alpha by signal strength', () => {
  assert.deepEqual(snrStyle(-5), { width: 2.6, alpha: 0.95 });
  assert.deepEqual(snrStyle(-15), { width: 1.8, alpha: 0.7 });
  assert.deepEqual(snrStyle(-25), { width: 1.3, alpha: 0.5 });
  assert.deepEqual(snrStyle(-35), { width: 1.1, alpha: 0.38 });
  assert.deepEqual(snrStyle(null), { width: 1.1, alpha: 0.38 });
  const strong = arcColor('20m', -5);
  const weak = arcColor('20m', -35);
  assert.notEqual(
    strong.toCssColorString(),
    arcColor('40m', -5).toCssColorString(),
  );
  assert.ok(strong.alpha > weak.alpha);
});

test('source returns a validated snapshot and throws on failure shapes', async () => {
  const ok = createWsprSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => payload([spot()]),
    }),
  });
  const snap = await ok.getSnapshot();
  assert.equal(snap.spots.length, 1);
  assert.equal(snap.spots[0].id, 13651166648);

  const unavailable = createWsprSource({
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  await assert.rejects(() => unavailable.getSnapshot(), /wspr_unavailable/);

  const errorEnvelope = createWsprSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ error: 'wspr_unavailable', detail: 'boom' }),
    }),
  });
  await assert.rejects(() => errorEnvelope.getSnapshot(), /Malformed WSPR/);
});

function fakeViewer() {
  const added = [];
  return {
    added,
    dataSources: {
      add: (ds) => added.push(ds),
      remove: () => {},
    },
  };
}

test('layer renders one arc entity per spot, each retaining its spot id', async () => {
  const fixture = payload([
    spot({ id: 111, freqMHz: 7.0401 }),
    spot({ id: 222, freqMHz: 14.0971 }),
  ]);
  const layer = createWsprLayer({
    source: {
      getSnapshot: async () => normalizeWsprPayload(fixture),
    },
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  const dataSource = viewer.added[0];
  assert.equal(dataSource.show, false); // default off
  layer.enable(viewer);
  assert.equal(dataSource.show, true);
  assert.equal(await layer.update(viewer), true);

  const entities = dataSource.entities.values;
  assert.equal(entities.length, 2);
  assert.deepEqual(entities.map((e) => e.id).sort(), [
    'wspr-arc:111',
    'wspr-arc:222',
  ]);
  const now = Cesium.JulianDate.now();
  assert.deepEqual(
    entities
      .map((e) => e.properties.spotId.getValue(now))
      .sort((a, b) => a - b),
    [111, 222],
  );
  assert.ok(entities.every((e) => e.polyline));
  const stats = layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.received, 2);
  assert.equal(stats.capped, false);
  assert.equal(stats.error, null);
  // The analyst seam traces the same ids (§7).
  assert.deepEqual(
    layer
      .getAnalystRecords()
      .map((r) => r.spotId)
      .sort((a, b) => a - b),
    [111, 222],
  );
  layer.disable(viewer);
  assert.equal(dataSource.show, false);
  assert.deepEqual(layer.getAnalystRecords(), []);
});

test('layer keeps its last good arcs when a refresh fails', async () => {
  let fail = false;
  const layer = createWsprLayer({
    source: {
      getSnapshot: async () => {
        if (fail) throw new Error('WSPR HTTP 502');
        return normalizeWsprPayload(payload([spot({ id: 111 })]));
      },
    },
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  const dataSource = viewer.added[0];
  assert.equal(dataSource.entities.values.length, 1);
  fail = true;
  assert.equal(await layer.update(viewer), false);
  assert.equal(dataSource.entities.values.length, 1); // not emptied
  assert.match(layer.getStats().error, /WSPR HTTP 502/);
});
