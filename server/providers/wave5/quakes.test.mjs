import assert from 'node:assert/strict';
import test from 'node:test';
import { quakesProxy, _quakesInternals } from './quakes.js';

const {
  parseUsgs,
  parseJma,
  parseJmaCoord,
  parseBmkg,
  parseGeonet,
  parseEmsc,
  dedupeQuakes,
  buildSnapshot,
  clearCaches,
} = _quakesInternals;

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

// ——— fixtures (shapes verified against the live endpoints 2026-09-27) ———

const USGS_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      id: 'us7000ti1p',
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-150.5, 60.2, 33.0] },
      properties: { mag: 6.5, place: 'Southern Alaska', time: 1759000000000, title: 'M 6.5 - Southern Alaska' },
    },
    {
      id: 'us7000ti2q',
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [140.0, 35.0, 40.0] },
      properties: { mag: 4.5, place: 'Near east coast of Honshu, Japan', time: 1758990000000 },
    },
    { id: '', type: 'Feature', geometry: null, properties: {} }, // junk: dropped
  ],
};

const JMA_FIXTURE = [
  // same event, three bulletins: intensity-only (no cod), early (ser 0), final (ser 1)
  { ctt: '20260926103251', eid: '20260926103120', ser: 0, at: '2026-09-26T10:31:00+09:00', anm: '', acd: '', cod: '', mag: '', maxi: '4', en_anm: '' },
  { ctt: '20260926103409', eid: '20260926103120', ser: 0, at: '2026-09-26T10:31:00+09:00', anm: '熊本県熊本地方', cod: '+32.8+130.8-10000/', mag: '4.5', maxi: '', en_anm: 'Kumamoto Region, Kumamoto Prefecture' },
  { ctt: '20260926103535', eid: '20260926103120', ser: '1', at: '2026-09-26T10:31:00+09:00', anm: '熊本県熊本地方', cod: '+32.8+130.8-10000/', mag: '4.5', maxi: '4', en_anm: 'Kumamoto Region, Kumamoto Prefecture' },
  // distant quake: negative lat, depth given without sign
  { ctt: '20260926064840', eid: '20260926063141', ser: '1', at: '2026-09-26T06:23:00+09:00', anm: '南太平洋', cod: '-21.2+168.5/', mag: '7.0', maxi: '', en_anm: 'South Pacific Ocean' },
];

const BMKG_FIXTURE = {
  Infogempa: {
    gempa: {
      Tanggal: '28 Sep 2026',
      Jam: '00:54:05 WIB',
      DateTime: '2026-09-27T17:54:05+00:00',
      Coordinates: '4.76,96.70',
      Lintang: '4.76 LU',
      Bujur: '96.70 BT',
      Magnitude: '3.4',
      Kedalaman: '10 km',
      Wilayah: 'Pusat gempa berada di darat 18 km barat Bener Meriah',
      Potensi: 'Gempa ini dirasakan untuk diteruskan pada masyarakat',
    },
  },
};

const GEONET_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [178.301177979, -37.721412659] },
      properties: {
        publicID: '2026p576643',
        time: '2026-08-02T08:35:27.284Z',
        depth: 39.32246398925781,
        magnitude: 5.660129676914746,
        mmi: 6,
        locality: '10 km south-west of Te Araroa',
        quality: 'best',
      },
    },
  ],
};

const EMSC_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [99.63, 35.39, -10.0] },
      id: '20260927_0000209',
      properties: {
        source_id: '2066194',
        lastupdate: '2026-09-27T17:44:14.549313Z',
        time: '2026-09-27T16:43:11.3Z',
        flynn_region: 'SOUTHERN QINGHAI, CHINA',
        lat: 35.39,
        lon: 99.63,
        depth: 10.0,
        mag: 5.0,
        magtype: 'mb',
        unid: '20260927_0000209',
      },
    },
  ],
};

// ——— parser tests ———

test('parseUsgs normalizes one feature per quake, drops junk', () => {
  const out = parseUsgs(USGS_FIXTURE);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'usgs:us7000ti1p');
  assert.equal(out[0].mag, 6.5);
  assert.equal(out[0].lat, 60.2);
  assert.equal(out[0].lon, -150.5);
  assert.equal(out[0].depthKm, 33);
  assert.equal(out[0].time, new Date(1759000000000).toISOString());
  assert.deepEqual(out[0].sources, ['usgs']);
});

test('parseJmaCoord handles signed lat/lon/depth-metres', () => {
  assert.deepEqual(parseJmaCoord('+35.5+140.4-40000/'), { lat: 35.5, lon: 140.4, depthKm: 40 });
  assert.deepEqual(parseJmaCoord('-21.2+168.5/'), { lat: -21.2, lon: 168.5, depthKm: null });
  assert.deepEqual(parseJmaCoord('+32.3+130.4+0/'), { lat: 32.3, lon: 130.4, depthKm: 0 });
  assert.equal(parseJmaCoord(''), null);
  assert.equal(parseJmaCoord(null), null);
});

test('parseJma dedupes bulletins by eid, keeps final, skips cod-less', () => {
  const out = parseJma(JMA_FIXTURE);
  assert.equal(out.length, 2); // two distinct eids
  const kumamoto = out.find((q) => q.id === 'jma:20260926103120');
  assert.ok(kumamoto);
  assert.equal(kumamoto.mag, 4.5);
  assert.equal(kumamoto.depthKm, 10);
  assert.equal(kumamoto.place, 'Kumamoto Region, Kumamoto Prefecture');
  const pacific = out.find((q) => q.id === 'jma:20260926063141');
  assert.equal(pacific.lat, -21.2);
  assert.equal(pacific.depthKm, null);
});

test('parseBmkg parses the single latest quake', () => {
  const out = parseBmkg(BMKG_FIXTURE);
  assert.equal(out.length, 1);
  assert.equal(out[0].lat, 4.76);
  assert.equal(out[0].lon, 96.7);
  assert.equal(out[0].mag, 3.4);
  assert.equal(out[0].depthKm, 10);
  assert.equal(out[0].time, '2026-09-27T17:54:05.000Z');
  assert.match(out[0].place, /Bener Meriah/);
});

test('parseGeonet normalizes publicID/time/magnitude/locality', () => {
  const out = parseGeonet(GEONET_FIXTURE);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'geonet:2026p576643');
  assert.equal(out[0].lat, -37.7214);
  assert.equal(out[0].mag, 5.7);
  assert.equal(out[0].depthKm, 39.3);
  assert.match(out[0].place, /Te Araroa/);
});

test('parseEmsc normalizes FDSN GeoJSON', () => {
  const out = parseEmsc(EMSC_FIXTURE);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'emsc:20260927_0000209');
  assert.equal(out[0].lat, 35.39);
  assert.equal(out[0].lon, 99.63);
  assert.equal(out[0].mag, 5);
  assert.equal(out[0].place, 'SOUTHERN QINGHAI, CHINA');
});

// ——— dedupe tests ———

test('dedupeQuakes merges same event across sources, keeps fields of richer report', () => {
  // Honshu quake seen by USGS (M4.5) and JMA (M4.6, 1 min later, ~30 km away)
  const a = {
    id: 'usgs:abc', lat: 35.0, lon: 140.0, depthKm: 40, mag: 4.5,
    place: 'Near east coast of Honshu', time: '2026-09-27T10:00:00.000Z', sources: ['usgs'],
  };
  const b = {
    id: 'jma:xyz', lat: 35.2, lon: 140.2, depthKm: 38, mag: 4.6,
    place: 'Chiba offshore', time: '2026-09-27T10:01:00.000Z', sources: ['jma'],
  };
  const far = {
    id: 'geonet:far', lat: -37.7, lon: 178.3, depthKm: 39, mag: 5.7,
    place: 'Te Araroa', time: '2026-09-27T10:00:30.000Z', sources: ['geonet'],
  };
  const out = dedupeQuakes([a, b, far]);
  assert.equal(out.length, 2);
  const merged = out.find((q) => q.sources.includes('usgs'));
  assert.deepEqual(merged.sources.sort(), ['jma', 'usgs']);
  assert.equal(merged.id, 'jma:xyz'); // higher-mag report wins the fields
  assert.equal(merged.mag, 4.6);
});

test('dedupeQuakes does not merge when mag differs beyond tolerance', () => {
  const a = {
    id: 'usgs:a', lat: 35.0, lon: 140.0, depthKm: 40, mag: 4.5,
    place: 'x', time: '2026-09-27T10:00:00.000Z', sources: ['usgs'],
  };
  const b = {
    id: 'emsc:b', lat: 35.05, lon: 140.05, depthKm: 40, mag: 6.5,
    place: 'y', time: '2026-09-27T10:00:30.000Z', sources: ['emsc'],
  };
  assert.equal(dedupeQuakes([a, b]).length, 2);
});

// ——— handler tests (fetch-mocked) ———

function mockFetchFor(bodyByHost) {
  return async (url) => {
    const host = new URL(url).hostname;
    const body = bodyByHost[host];
    if (body === undefined) return new Response('down', { status: 503 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

const ALL_BODIES = {
  'earthquake.usgs.gov': USGS_FIXTURE,
  'www.jma.go.jp': JMA_FIXTURE,
  'data.bmkg.go.id': BMKG_FIXTURE,
  'api.geonet.org.nz': GEONET_FIXTURE,
  'seismicportal.eu': EMSC_FIXTURE,
};

test('quakesProxy mounts /api/quakes on both server shapes', () => {
  const routes = mount(quakesProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/quakes', '/api/quakes']);
});

test('handler aggregates all five sources with mocked fetch', async () => {
  clearCaches();
  const calls = mount(quakesProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchFor(ALL_BODIES);
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/quakes'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.ok(payload.generatedAt);
    assert.equal(payload.sources.usgs.ok, true);
    assert.equal(payload.sources.usgs.count, 2);
    assert.equal(payload.sources.jma.count, 2);
    assert.equal(payload.sources.bmkg.count, 1);
    assert.equal(payload.sources.geonet.count, 1);
    assert.equal(payload.sources.emsc.count, 1);
    assert.equal(payload.count, payload.quakes.length);
    assert.ok(payload.count >= 7); // 2+2+1+1+1 fixtures, nothing collides
    assert.match(res.headers['Cache-Control'], /max-age=180/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler degrades honestly when one source is down', async () => {
  clearCaches();
  const calls = mount(quakesProxy());
  const realFetch = globalThis.fetch;
  const bodies = { ...ALL_BODIES };
  delete bodies['www.jma.go.jp'];
  globalThis.fetch = mockFetchFor(bodies);
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/quakes'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.sources.jma.ok, false);
    assert.match(payload.sources.jma.error, /503/);
    assert.equal(payload.sources.usgs.ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when all upstreams are down', async () => {
  clearCaches();
  const calls = mount(quakesProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchFor({});
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/quakes'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /quakes_unavailable/);
    assert.match(res.body, /quakes_all_upstream_down/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(quakesProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/quakes', 'POST'), res);
  assert.equal(res.statusCode, 405);
});

test('buildSnapshot records per-source status and merges duplicates', () => {
  const results = [
    { key: 'usgs', ok: true, count: 1, attribution: 'USGS', latencyMs: 10, quakes: parseUsgs(USGS_FIXTURE).slice(0, 1) },
    { key: 'jma', ok: true, count: 0, attribution: 'JMA', latencyMs: 20, quakes: [] },
    { key: 'bmkg', ok: false, count: 0, attribution: 'BMKG', latencyMs: 5, error: 'fetch failed', quakes: [] },
    { key: 'geonet', ok: true, count: 0, attribution: 'GeoNet', latencyMs: 8, quakes: [] },
    { key: 'emsc', ok: true, count: 0, attribution: 'EMSC', latencyMs: 9, quakes: [] },
  ];
  const snap = buildSnapshot(results);
  assert.equal(snap.count, 1);
  assert.equal(snap.sources.bmkg.ok, false);
  assert.equal(snap.sources.bmkg.error, 'fetch failed');
  assert.equal(snap.sources.usgs.count, 1);
});
