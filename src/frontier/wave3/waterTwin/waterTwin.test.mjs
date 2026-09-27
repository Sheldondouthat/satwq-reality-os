import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bandLabel,
  bandColor,
  bandRank,
  reservoirBand,
  reservoirBandColor,
  reservoirBandLabel,
  summarizeTwin,
} from './twin.js';
import {
  selectLatestRadarFrame,
  tileUrlForFrame,
  tileTemplateForFrame,
  lonLatToTile,
  fetchPrecipitation,
  RAINVIEWER_TILE_HOST,
} from './precip.js';
import { RESERVOIRS, RIVERS } from '../../../../shared/waterTwinRegistry.js';

const mapsFixture = {
  version: '1.0',
  generated: 1758950000,
  host: 'https://tilecache.rainviewer.com',
  radar: {
    past: [
      { time: 1758949200, path: '/v2/radar/1758949200' },
      { time: 1758949500, path: '/v2/radar/1758949500' },
    ],
    nowcast: [{ time: 1758949800, path: '/v2/radar/1758949800' }],
  },
};

test('selectLatestRadarFrame: picks the last past frame, ignores nowcast', () => {
  const f = selectLatestRadarFrame(mapsFixture);
  assert.deepEqual(f, { time: 1758949500, path: '/v2/radar/1758949500' });
});

test('selectLatestRadarFrame: null on missing/malformed radar', () => {
  assert.equal(selectLatestRadarFrame(null), null);
  assert.equal(selectLatestRadarFrame({}), null);
  assert.equal(selectLatestRadarFrame({ radar: { past: [{ time: 'x' }] } }), null);
  assert.equal(selectLatestRadarFrame({ radar: { past: [{ path: '/only-path' }] } }), null);
});

test('tileUrlForFrame: composes the RainViewer tile URL', () => {
  const url = tileUrlForFrame('/v2/radar/1758949500', 6, 18, 24);
  assert.equal(url, `${RAINVIEWER_TILE_HOST}/v2/radar/1758949500/256/6/18/24/2/1_1.png`);
});

test('tileTemplateForFrame: template has {z}/{x}/{y} placeholders', () => {
  const t = tileTemplateForFrame('/v2/radar/1758949500');
  assert.ok(t.includes('{z}') && t.includes('{x}') && t.includes('{y}'), t);
  assert.ok(!t.includes('{z}/{x}/{y}/{z}'), 'no doubled placeholders');
});

test('lonLatToTile: equator/prime-meridian at z=1 is tile (1,1)', () => {
  assert.deepEqual(lonLatToTile(0, 0, 1), { x: 1, y: 1 });
});

test('lonLatToTile: St. Louis gauge tile at z=6 stays in the US midwest', () => {
  const { x, y } = lonLatToTile(-90.18, 38.62, 6);
  // z=6: 64x64 tiles; lon -90.18 -> x in [15,17]; lat 38.62 -> y in [23,25]
  assert.ok(x >= 15 && x <= 17, `x=${x}`);
  assert.ok(y >= 23 && y <= 25, `y=${y}`);
});

test('fetchPrecipitation: composes per-point tiles for every registry site', async () => {
  const fetchImpl = async (url) => {
    assert.ok(String(url).includes('rainviewer.com'), url);
    return { ok: true, json: async () => mapsFixture };
  };
  const p = await fetchPrecipitation({ fetchImpl, zoom: 6 });
  assert.equal(p.available, true);
  assert.equal(p.frameTime, 1758949500);
  assert.ok(p.tileTemplate.includes('/v2/radar/1758949500/'), p.tileTemplate);
  assert.equal(p.points.length, RESERVOIRS.length + RIVERS.length);
  for (const pt of p.points) {
    assert.ok(pt.tileUrl.startsWith(`${RAINVIEWER_TILE_HOST}/v2/radar/1758949500/256/6/`), pt.tileUrl);
    assert.ok(Number.isFinite(pt.lat) && Number.isFinite(pt.lon), `${pt.key} has coords`);
  }
  assert.match(p.note, /observed/i);
  assert.ok(!/forecast/i.test(p.note) || /not a forecast/.test(p.note), 'never labeled a forecast');
});

test('fetchPrecipitation: fail-soft on upstream errors', async () => {
  const down = await fetchPrecipitation({ fetchImpl: async () => { throw new Error('net down'); } });
  assert.equal(down.available, false);
  const bad = await fetchPrecipitation({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(bad.available, false);
  const empty = await fetchPrecipitation({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(empty.available, false);
});

test('registry: every reservoir and river has display coordinates', () => {
  for (const r of RESERVOIRS) {
    assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lon), `${r.id} coords`);
  }
  for (const r of RIVERS) {
    assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lon), `${r.site} coords`);
  }
});

test('bandLabel: known bands have labels, unknown falls back', () => {
  assert.equal(bandLabel('major-flood'), 'Major flooding');
  assert.equal(bandLabel('normal'), 'Normal');
  assert.equal(bandLabel('bogus'), 'No reading');
});

test('bandColor: returns a hex color for every band', () => {
  for (const b of ['major-flood', 'moderate-flood', 'minor-flood', 'action', 'normal', 'unknown']) {
    assert.match(bandColor(b), /^#[0-9a-f]{6}$/, b);
  }
});

test('bandRank: severity ordering is monotonic', () => {
  const bands = ['unknown', 'normal', 'action', 'minor-flood', 'moderate-flood', 'major-flood'];
  for (let i = 1; i < bands.length; i++) {
    assert.ok(bandRank(bands[i]) > bandRank(bands[i - 1]));
  }
});

test('reservoirBand: thresholds at 25/50/75', () => {
  assert.equal(reservoirBand(10), 'critical');
  assert.equal(reservoirBand(30), 'low');
  assert.equal(reservoirBand(60), 'moderate');
  assert.equal(reservoirBand(90), 'healthy');
  assert.equal(reservoirBand(NaN), 'unknown');
  assert.equal(reservoirBand(null), 'unknown');
});

test('reservoirBandColor/Label: consistent pairs', () => {
  for (const b of ['critical', 'low', 'moderate', 'healthy', 'unknown']) {
    assert.match(reservoirBandColor(b), /^#[0-9a-f]{6}$/, b);
    assert.ok(reservoirBandLabel(b).length > 0, b);
  }
});

test('summarizeTwin: picks worst river and driest reservoir', () => {
  const s = summarizeTwin({
    reservoirs: [
      { name: 'A', status: 'live', pctFull: 60 },
      { name: 'B', status: 'live', pctFull: 20 },
      { name: 'C', status: 'unavailable', pctFull: null },
    ],
    rivers: [
      { name: 'R1', status: 'live', band: 'normal' },
      { name: 'R2', status: 'live', band: 'minor-flood' },
      { name: 'R3', status: 'unavailable', band: 'unknown' },
    ],
  });
  assert.equal(s.reservoirsLive, 2);
  assert.equal(s.riversLive, 2);
  assert.equal(s.worstRiver.name, 'R2');
  assert.equal(s.driestReservoir.name, 'B');
});

test('summarizeTwin: empty payload does not throw', () => {
  const s = summarizeTwin(null);
  assert.equal(s.reservoirsLive, 0);
  assert.equal(s.riversLive, 0);
  assert.equal(s.worstRiver, null);
  assert.equal(s.driestReservoir, null);
});
