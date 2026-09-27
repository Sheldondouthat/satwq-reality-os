import assert from 'node:assert/strict';
import test from 'node:test';
import { donkiProxy, _donkiInternals } from './donki.js';

const { parseCme, parseCmeAnalysis, parseFlares, parseStorms, parseNotifications, buildSnapshot } = _donkiInternals;

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
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

// Shapes mirror the live CCMC DONKI responses probed 2026-09-27.

const SAMPLE_CME = [
  {
    activityID: '2026-08-28T00:00:00-CME-001',
    catalog: 'M2M_CATALOG',
    startTime: '2026-08-28T00:00Z',
    instruments: [{ displayName: 'SOHO: LASCO/C2' }, { displayName: 'SOHO: LASCO/C3' }],
    sourceLocation: '',
    activeRegionNum: null,
    note: 'CME visible to the SE in SOHO LASCO C2.',
    link: 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/view/CME/48700/-1',
  },
];

const SAMPLE_CME_ANALYSIS = [
  {
    associatedCMEID: '2026-08-28T00:00:00-CME-001',
    time21_5: '2026-08-28T03:16Z',
    latitude: 24.0,
    longitude: 156.0,
    halfAngle: 14.0,
    speed: 318.0,
    type: 'S',
    isMostAccurate: true,
    note: 'Triangulation between SOHO LASCO C2 and STEREO A COR2.',
    submissionTime: '2026-08-29T18:45Z',
  },
  {
    associatedCMEID: '2026-08-28T00:00:00-CME-001',
    time21_5: '2026-08-28T04:00Z',
    latitude: 20.0,
    longitude: 150.0,
    halfAngle: 12.0,
    speed: 290.0,
    type: 'S',
    isMostAccurate: false,
    note: 'Preliminary.',
    submissionTime: '2026-08-28T20:00Z',
  },
];

const SAMPLE_FLR = [
  {
    flrID: '2026-08-30T01:10:00-FLR-001',
    catalog: 'M2M_CATALOG',
    instruments: [{ displayName: 'GOES-P: EXIS 1.0-8.0' }],
    beginTime: '2026-08-30T01:10Z',
    peakTime: '2026-08-30T01:20Z',
    endTime: '2026-08-30T01:25Z',
    classType: 'C3.0',
    sourceLocation: 'N12E90',
    activeRegionNum: 14521,
    note: 'Active Region 4521 was numbered on 2026-08-31.',
    link: 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/view/FLR/48800/-1',
  },
];

const SAMPLE_GST = [
  {
    gstID: '2026-09-01T00:00:00-GST-001',
    startTime: '2026-09-01T06:00Z',
    allKpIndex: [
      { observedTime: '2026-09-01T09:00Z', kpIndex: 4.33, source: 'NOAA' },
      { observedTime: '2026-09-01T12:00Z', kpIndex: 5.67, source: 'NOAA' },
    ],
    link: 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/view/GST/48900/-1',
  },
];

const SAMPLE_NOTIFICATIONS = [
  {
    messageType: 'RBE',
    messageID: '20260926-AL-002',
    messageURL: 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/view/Alert/48827/1',
    messageIssueTime: '2026-09-26T14:25Z',
    messageBody: '## CCMC DONKI\n## Message Type: Space Weather Notification - Radiation Belt Enhancement\nbody…',
  },
];

test('donkiProxy mounts /api/donki on both server shapes', () => {
  const routes = mount(donkiProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/donki', '/api/donki']);
});

test('parseCme keeps essential fields and sorts newest-first', () => {
  const cmes = parseCme(SAMPLE_CME);
  assert.equal(cmes.length, 1);
  assert.equal(cmes[0].id, '2026-08-28T00:00:00-CME-001');
  assert.equal(cmes[0].startTime, '2026-08-28T00:00:00.000Z');
  assert.deepEqual(cmes[0].instruments, ['SOHO: LASCO/C2', 'SOHO: LASCO/C3']);
  assert.equal(cmes[0].analysis, null);
});

test('parseCmeAnalysis joins on associatedCMEID and prefers most-accurate', () => {
  const map = parseCmeAnalysis(SAMPLE_CME_ANALYSIS);
  assert.equal(map.size, 1);
  const a = map.get('2026-08-28T00:00:00-CME-001');
  assert.equal(a.speedKms, 318);
  assert.equal(a.isMostAccurate, true);
});

test('parseFlares captures flare class and AR number', () => {
  const flares = parseFlares(SAMPLE_FLR);
  assert.equal(flares.length, 1);
  assert.equal(flares[0].class, 'C3.0');
  assert.equal(flares[0].activeRegionNum, 14521);
  assert.equal(flares[0].peakTime, '2026-08-30T01:20:00.000Z');
});

test('parseStorms computes kpMax; empty GST array stays valid', () => {
  const storms = parseStorms(SAMPLE_GST);
  assert.equal(storms.length, 1);
  assert.equal(storms[0].kpMax, 5.67);
  assert.equal(storms[0].kpSamples, 2);
  assert.deepEqual(parseStorms([]), []); // quiet sun is valid, not an error
});

test('parseNotifications trims body and keeps type/url', () => {
  const n = parseNotifications(SAMPLE_NOTIFICATIONS);
  assert.equal(n.length, 1);
  assert.equal(n[0].type, 'RBE');
  assert.equal(n[0].url, 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/view/Alert/48827/1');
  assert.ok(n[0].body.length <= 1200);
});

test('buildSnapshot joins CME analysis and records per-source errors', () => {
  const mk = (key, ok, data, error) => ({
    key, ok, attribution: 'NASA/CCMC DONKI', latencyMs: 5,
    ...(ok ? { data } : { error, data: null }),
  });
  const payload = buildSnapshot([
    mk('cme', true, SAMPLE_CME),
    mk('cmeAnalysis', true, SAMPLE_CME_ANALYSIS),
    mk('flares', true, SAMPLE_FLR),
    mk('storms', false, null, 'donki_storms_upstream_503'),
    mk('notifications', true, SAMPLE_NOTIFICATIONS),
  ]);
  assert.equal(payload.cme[0].analysis.speedKms, 318);
  assert.equal(payload.sources.storms.ok, false);
  assert.match(payload.sources.storms.error, /503/);
  assert.equal(payload.sources.flares.ok, true);
  assert.equal(payload.windowDays, 30);
});

function mockFetchByPrefix(map) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    for (const [prefix, { status, body }] of Object.entries(map)) {
      // Anchor on the feed name: '.../get/CME' must not swallow '.../get/CMEAnalysis'.
      if (url.startsWith(prefix) && (url.length === prefix.length || url[prefix.length] === '?' || url[prefix.length] === '/')) {
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  };
  return () => { globalThis.fetch = realFetch; };
}

test('handler serves snapshot; GST quiet ([]) does not fail the snapshot', async () => {
  _donkiInternals.clearCaches();
  const calls = mount(donkiProxy());
  const restore = mockFetchByPrefix({
    'https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/CME': { status: 200, body: SAMPLE_CME },
    'https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/CMEAnalysis': { status: 200, body: SAMPLE_CME_ANALYSIS },
    'https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/FLR': { status: 200, body: SAMPLE_FLR },
    'https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/GST': { status: 200, body: [] },
    'https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/notifications': { status: 200, body: SAMPLE_NOTIFICATIONS },
  });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/donki'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.cme.length, 1);
    assert.equal(payload.cme[0].analysis.speedKms, 318);
    assert.deepEqual(payload.geomagneticStorms, []);
    assert.equal(payload.sources.storms.ok, true); // quiet is success
    assert.match(res.headers['Cache-Control'], /max-age=1800/);
  } finally {
    restore();
  }
});

test('handler tries the api.nasa.gov fallback when CCMC fails', async () => {
  _donkiInternals.clearCaches();
  const calls = mount(donkiProxy());
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(url);
    if (url.includes('kauai.ccmc.gsfc.nasa.gov')) return new Response('down', { status: 503 });
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/donki'), res);
    assert.equal(res.statusCode, 200);
    assert.ok(seen.some((u) => u.includes('api.nasa.gov/DONKI/CME')));
    assert.ok(seen.some((u) => u.includes('api_key=DEMO_KEY')));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when every source is down', async () => {
  _donkiInternals.clearCaches();
  const calls = mount(donkiProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/donki'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /donki_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(donkiProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/donki', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
