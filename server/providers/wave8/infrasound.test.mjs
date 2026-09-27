import assert from 'node:assert/strict';
import test from 'node:test';
import { infrasoundProxy, _infrasoundInternals } from './infrasound.js';

const { parseGeoCsvSlist, downsample, buildInfrasoundPayload, buildDataselectUrl, STATIONS, clearCaches } =
  _infrasoundInternals;

// LIVE CAPTURE — fetched 2026-09-27 from the build VM (HTTP 200,
// content-type text/csv, 3373 samples @ 20 Hz from IM.I53H1.BDF).
// This is a genuine EarthScope geocsv.slist response, trimmed to 30 samples.
const LIVE_CAPTURE = [
  '# dataset: GeoCSV 2.0',
  '# delimiter: , ',
  '# SID: IM_I53H1__BDF',
  '# sample_count: 3373',
  '# sample_rate_hz: 20',
  '# start_time: 2026-09-27T21:33:36.000000Z',
  '# latitude_deg: 64.875',
  '# longitude_deg: -147.86114',
  '# elevation_m: 200.3',
  '# depth_m: 0.0',
  '# azimuth_deg: 0.0',
  '# dip_deg: 0.0',
  '# instrument: Hyperion_5313A=Centaur',
  '# scale_factor: 20760.2',
  '# scale_frequency_hz: 1.0',
  '# scale_units: Pa',
  '# field_unit: Counts',
  '# field_type: INTEGER',
  'Sample',
  '3365', '3470', '3374', '3399', '3359', '3353', '3196', '3250', '3397', '2995',
  '3181', '3221', '3027', '3166', '3041', '2984', '3063', '2962', '2907', '3007',
  '2891', '2984', '2940', '2954', '2977', '2989', '3029', '2845', '3039', '2846',
].join('\n');

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { chunks.push(body); res.body = chunks.join(''); },
    once() {},
    removeListener() {},
  };
  return res;
}

function fakeReq(url, method = 'GET') {
  return { method, url, on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('infrasoundProxy mounts /api/infrasound-ims on both server shapes', () => {
  const routes = mount(infrasoundProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/infrasound-ims', '/api/infrasound-ims']);
});

test('parseGeoCsvSlist parses the live capture header', () => {
  const p = parseGeoCsvSlist(LIVE_CAPTURE);
  assert.equal(p.sid, 'IM_I53H1__BDF');
  assert.equal(p.sampleRateHz, 20);
  assert.equal(p.startMs, Date.parse('2026-09-27T21:33:36.000000Z'));
  assert.equal(p.scaleFactor, 20760.2);
  assert.equal(p.scaleUnits, 'Pa');
  assert.equal(p.instrument, 'Hyperion_5313A=Centaur');
  assert.equal(p.lat, 64.875);
  assert.equal(p.lon, -147.86114);
  assert.equal(p.samples.length, 30);
  assert.equal(p.samples[0], 3365);
  assert.equal(p.headerSampleCount, 3373);
});

test('parseGeoCsvSlist rejects garbage and wrong formats', () => {
  assert.throws(() => parseGeoCsvSlist('not a geocsv at all'), /infrasound_geocsv_invalid/);
  assert.throws(() => parseGeoCsvSlist('# dataset: GeoCSV 2.0\nSamples\n1\n2\n'), /infrasound_geocsv_invalid/);
  assert.throws(() => parseGeoCsvSlist(LIVE_CAPTURE.replace('3365', 'NaN')), /infrasound_geocsv_invalid/);
});

test('downsample strides long arrays and keeps timing metadata', () => {
  const arr = Array.from({ length: 6000 }, (_, i) => i);
  const { stride, values } = downsample(arr, 300);
  assert.equal(stride, 20);
  assert.ok(values.length <= 300);
  assert.equal(values[0], 0);
  assert.equal(values[1], 20);
  const small = downsample([1, 2, 3], 300);
  assert.deepEqual(small, { stride: 1, values: [1, 2, 3] });
});

test('buildInfrasoundPayload calibrates Pa and labels the station honestly', () => {
  const parsed = parseGeoCsvSlist(LIVE_CAPTURE);
  const payload = buildInfrasoundPayload(parsed, { station: 'I53H1', minutes: 5, nowMs: 1_000_000 });
  assert.equal(payload.stale, false);
  assert.ok(payload.generatedAt);
  assert.equal(payload.station.network, 'IM');
  assert.equal(payload.station.station, 'I53H1');
  assert.equal(payload.station.channel, 'BDF');
  assert.equal(payload.acquisition.sampleRateHz, 20);
  assert.equal(payload.acquisition.actualSampleCount, 30);
  assert.equal(payload.acquisition.headerSampleCount, 3373);
  // counts -> Pa: first sample 3365 / 20760.2 ≈ 0.16208
  assert.ok(Math.abs(payload.series.valuesPa[0] - 3365 / 20760.2) < 1e-9);
  assert.match(payload.stats.pascalsNote, /scale_factor/);
  assert.match(payload.attribution, /EarthScope/);
  assert.match(payload.attribution, /miniSEED/);
});

test('buildDataselectUrl targets geocsv.slist with followable params', () => {
  const url = buildDataselectUrl({ station: 'I53H1', minutes: 5, endMs: Date.parse('2026-09-27T21:40:00Z') });
  assert.match(url, /^https:\/\/service\.earthscope\.org\/fdsnws\/dataselect\/1\/query\?/);
  assert.match(url, /network=IM/);
  assert.match(url, /station=I53H1/);
  assert.match(url, /channel=BDF/);
  assert.match(url, /format=geocsv\.slist/);
  assert.match(url, /starttime=2026-09-27T21%3A35%3A00Z/);
  assert.match(url, /endtime=2026-09-27T21%3A40%3A00Z/);
});

test('handler 400s on unknown station and bad minutes', async () => {
  clearCaches();
  const provider = infrasoundProxy({ fetchImpl: async () => { throw new Error('should not fetch'); } });
  const { handler } = mount(provider)[0];
  const res1 = fakeRes();
  await handler(fakeReq('/api/infrasound?station=XX01'), res1);
  assert.equal(res1.statusCode, 400);
  const res2 = fakeRes();
  await handler(fakeReq('/api/infrasound?minutes=99'), res2);
  assert.equal(res2.statusCode, 400);
});

test('handler serves parsed waveform from a stubbed fetch', async () => {
  clearCaches();
  const stub = async () => new Response(LIVE_CAPTURE, { status: 200, headers: { 'content-type': 'text/csv' } });
  const provider = infrasoundProxy({ fetchImpl: stub, now: () => 1_000_000 });
  const { handler } = mount(provider)[0];
  const res = fakeRes();
  await handler(fakeReq('/api/infrasound'), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.station.sid, 'IM_I53H1__BDF');
  assert.equal(body.series.valuesPa.length, 30);
  assert.equal(body.stale, false);
});

test('handler returns 502 with honest error when upstream is empty', async () => {
  clearCaches();
  const stub = async () => new Response(null, { status: 204 });
  const provider = infrasoundProxy({ fetchImpl: stub, now: () => 2_000_000 });
  const { handler } = mount(provider)[0];
  const res = fakeRes();
  await handler(fakeReq('/api/infrasound'), res);
  assert.equal(res.statusCode, 502);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'infrasound_unavailable');
  assert.match(body.detail, /no_data_in_window/);
});

test('handler serves stale cache when upstream fails', async () => {
  clearCaches();
  const good = async () => new Response(LIVE_CAPTURE, { status: 200 });
  const provider = infrasoundProxy({ fetchImpl: good, now: () => 3_000_000 });
  const first = fakeRes();
  await mount(provider)[0].handler(fakeReq('/api/infrasound'), first);
  assert.equal(first.statusCode, 200);
  // rebuild with a failing fetch; cache is warm from the same now() clock
  const bad = async () => { throw Object.assign(new Error('boom'), { status: 502 }); };
  const provider2 = infrasoundProxy({ fetchImpl: bad, now: () => 3_000_000 + 90_000 });
  const res = fakeRes();
  await mount(provider2)[0].handler(fakeReq('/api/infrasound'), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.stale, true);
  assert.equal(body.station.station, 'I53H1');
});

test('STATIONS covers the full I53US array', () => {
  assert.deepEqual(STATIONS, ['I53H1', 'I53H2', 'I53H3', 'I53H4', 'I53H5', 'I53H6', 'I53H7', 'I53H8']);
});

test('stale fallback never serves a cache entry from a different query', async () => {
  clearCaches();
  const good = async () => new Response(LIVE_CAPTURE, { status: 200 });
  const provider = infrasoundProxy({ fetchImpl: good, now: () => 4_000_000 });
  const first = fakeRes();
  await mount(provider)[0].handler(fakeReq('/api/infrasound?station=I53H1'), first);
  assert.equal(first.statusCode, 200);
  // A different station fails upstream: must 502, not serve I53H1's cache.
  const bad = async () => { throw Object.assign(new Error('boom'), { status: 502 }); };
  const provider2 = infrasoundProxy({ fetchImpl: bad, now: () => 4_000_000 + 90_000 });
  const res = fakeRes();
  await mount(provider2)[0].handler(fakeReq('/api/infrasound?station=I53H2'), res);
  assert.equal(res.statusCode, 502);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'infrasound_unavailable');
});
