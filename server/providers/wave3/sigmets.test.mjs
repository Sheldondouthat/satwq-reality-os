import assert from 'node:assert/strict';
import test from 'node:test';
import { sigmetsProxy, trimSigmet, trimSigmetsPayload, trimMetar, trimTaf, _sigmetsInternals } from './sigmets.js';

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { chunks.push(body); res.body = chunks.join(''); },
  };
  return res;
}

function fakeReq(url, method = 'GET') {
  return { method, url, on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  const middlewares = { use: (route, handler) => calls.push({ route, handler }) };
  provider.configureServer({ middlewares });
  provider.configurePreviewServer({ middlewares });
  return calls;
}

const SAMPLE_SIGMETS = [
  {
    icaoId: 'SBGL',
    firId: 'SBAZ',
    firName: 'SBAZ AMAZONICA',
    hazard: 'TS',
    qualifier: 'EMBD',
    severity: '',
    base: null,
    top: 48000,
    validTimeFrom: 1790479800,
    validTimeTo: 1790494200,
    dir: '-',
    spd: '0',
    chng: 'NC',
    geom: 'AREA',
    coords: [
      { lon: -59.017, lat: -5.567 },
      { lon: -60.383, lat: -7.583 },
      { lon: -56.033, lat: -6.367 },
      { lon: -59.017, lat: -5.567 },
    ],
    rawSigmet: 'WSBZ23 SBGL 270325 SBAZ SIGMET 30 VALID ...',
  },
  { icaoId: 'BAD', coords: [] }, // junk: dropped
];

const SAMPLE_METAR = [
  {
    icaoId: 'KJFK',
    obsTime: '2026-09-27T01:51:00Z',
    temp: 18.3,
    dewp: 12.8,
    wdir: 250,
    wspd: 8,
    wgst: null,
    visib: '16.09',
    fltCat: 'VFR',
    cover: 'FEW',
    lat: 40.64,
    lon: -73.78,
    name: 'John F Kennedy Intl',
    rawOb: 'KJFK 270151Z 25008KT 10SM FEW045 18/13 A2992',
  },
];

const SAMPLE_TAF = [
  {
    icaoId: 'KJFK',
    issueTime: '2026-09-27T00:00:00Z',
    validTimeFrom: '2026-09-27T01:00:00Z',
    validTimeTo: '2026-09-28T06:00:00Z',
    lat: 40.64,
    lon: -73.78,
    name: 'John F Kennedy Intl',
    rawTAF: 'KJFK 270000Z 2701/2806 25008KT P6SM FEW045',
  },
];

test('sigmetsProxy mounts all three routes on both server shapes', () => {
  const routes = mount(sigmetsProxy()).map((c) => c.route);
  assert.deepEqual(routes, [
    '/api/sigmets', '/api/airports/metar', '/api/airports/taf',
    '/api/sigmets', '/api/airports/metar', '/api/airports/taf',
  ]);
});

test('trimSigmet keeps fields, rounds coords, caps raw text', () => {
  const s = trimSigmet(SAMPLE_SIGMETS[0]);
  assert.equal(s.hazard, 'TS');
  assert.equal(s.top, 48000);
  assert.equal(s.coords.length, 4);
  assert.equal(s.coords[0].lon, -59.017);
  assert.ok(s.rawSigmet.startsWith('WSBZ23'));
});

test('trimSigmetsPayload drops junk items without valid rings', () => {
  const payload = trimSigmetsPayload(SAMPLE_SIGMETS);
  assert.equal(payload.count, 1);
  assert.equal(payload.sigmets[0].icaoId, 'SBGL');
  assert.equal(payload.source.includes('aviationweather'), true);
});

test('trimMetar keeps flight category and airport location', () => {
  const m = trimMetar(SAMPLE_METAR[0]);
  assert.equal(m.icaoId, 'KJFK');
  assert.equal(m.fltcat, 'VFR');
  assert.equal(m.lat, 40.64);
  assert.equal(m.lon, -73.78);
  assert.equal(m.wspd, 8);
});

test('trimTaf keeps validity window and raw text', () => {
  const t = trimTaf(SAMPLE_TAF[0]);
  assert.equal(t.icaoId, 'KJFK');
  assert.equal(t.validTimeFrom, '2026-09-27T01:00:00Z');
  assert.ok(t.rawTAF.includes('KJFK 270000Z'));
});

function withFetch(body, status = 200) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  return () => { globalThis.fetch = realFetch; };
}

test('/api/sigmets serves trimmed payload with mocked fetch', async () => {
  const calls = mount(sigmetsProxy());
  const restore = withFetch(JSON.stringify(SAMPLE_SIGMETS));
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/sigmets'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 1);
    assert.equal(payload.sigmets[0].firId, 'SBAZ');
  } finally {
    restore();
  }
});

test('/api/airports/metar validates station ids and serves reports', async () => {
  const calls = mount(sigmetsProxy());
  const metar = calls.find((c) => c.route === '/api/airports/metar').handler;
  const restore = withFetch(JSON.stringify(SAMPLE_METAR));
  try {
    const ok = fakeRes();
    await metar(fakeReq('/api/airports/metar?ids=KJFK'), ok);
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.body).reports[0].fltcat, 'VFR');

    const bad = fakeRes();
    await metar(fakeReq('/api/airports/metar?ids=!!!'), bad);
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body, /station_ids_required/);

    const missing = fakeRes();
    await metar(fakeReq('/api/airports/metar'), missing);
    assert.equal(missing.statusCode, 400);
  } finally {
    restore();
  }
});

test('/api/airports/taf serves TAF reports with mocked fetch', async () => {
  const calls = mount(sigmetsProxy());
  const taf = calls.find((c) => c.route === '/api/airports/taf').handler;
  const restore = withFetch(JSON.stringify(SAMPLE_TAF));
  try {
    const res = fakeRes();
    await taf(fakeReq('/api/airports/taf?ids=kjfk'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).reports[0].icaoId, 'KJFK');
  } finally {
    restore();
  }
});

test('/api/sigmets returns 502 JSON when upstream is down', async () => {
  _sigmetsInternals.clearCaches(); // avoid leaking the earlier test's 5-min cache
  const calls = mount(sigmetsProxy());
  const restore = withFetch('down', 503);
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/sigmets'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /sigmets_unavailable/);
  } finally {
    restore();
  }
});
