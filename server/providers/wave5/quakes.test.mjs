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
  selectDyfiCandidates,
  parseDyfiDetail,
  parseNumresp,
  parseDyfiZip,
  centroidOfPolygon,
  enrichDyfi,
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

// ——— Item 61: USGS DYFI enrichment tests (fixtures mirror live shapes observed 2026-09-27) ———

const USGS_DYFI_SUMMARY = {
  type: 'FeatureCollection',
  features: [
    {
      id: 'us6000txpi',
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [167.2, -21.5, 10.0] },
      properties: {
        mag: 6.6,
        place: '80 km ENE of Tadine, New Caledonia',
        time: 1790394000000,
        felt: 11,
        cdi: 6.9,
        title: 'M 6.6 - 80 km ENE of Tadine, New Caledonia',
      },
    },
    ...USGS_FIXTURE.features,
  ],
};

// fdsnws event detail returns a single Feature (not a FeatureCollection)
const DYFI_DETAIL_FIXTURE = {
  type: 'Feature',
  id: 'us6000txpi',
  properties: {
    mag: 6.6,
    place: '80 km ENE of Tadine, New Caledonia',
    time: 1790394000000,
    felt: 11,
    cdi: 6.9,
    products: {
      dyfi: [
        {
          code: 'us6000txpi',
          source: 'us',
          updateTime: 1790395024448,
          status: 'UPDATE',
          contents: {
            'dyfi_plot_numresp.json': {
              contentType: 'application/json',
              url: 'https://earthquake.usgs.gov/product/dyfi/us6000txpi/us/1790395024448/dyfi_plot_numresp.json',
            },
            'dyfi_zip.geojson': {
              contentType: 'application/json',
              url: 'https://earthquake.usgs.gov/product/dyfi/us6000txpi/us/1790395024448/dyfi_zip.geojson',
            },
          },
        },
      ],
      shakemap: [{ code: 'us6000txpi' }],
    },
  },
  geometry: { type: 'Point', coordinates: [167.2, -21.5, 10.0] },
};

const DYFI_NUMRESP_FIXTURE = {
  datasets: [
    {
      data: [
        { y: 1, x: 0.25, t_seconds: 902, t_absolute: '2026-09-25T21:38:05' },
        { y: 2, x: 0.39, t_seconds: 1410, t_absolute: '2026-09-25T21:46:33' },
        { y: 3, x: 0.43, t_seconds: 1532, t_absolute: '2026-09-25T21:48:35' },
        { y: 4, x: 0.45, t_seconds: 1616, t_absolute: '2026-09-25T21:49:59' },
        { y: 5, x: 0.46, t_seconds: 1654, t_absolute: '2026-09-25T21:50:37' },
        { y: 6, x: 0.62, t_seconds: 2219, t_absolute: '2026-09-25T22:00:02' },
        { y: 7, x: 0.75, t_seconds: 2714, t_absolute: '2026-09-25T22:08:17' },
        { y: 8, x: 0.78, t_seconds: 2818, t_absolute: '2026-09-25T22:10:01' },
        { y: 9, x: 1.74, t_seconds: 6271, t_absolute: '2026-09-25T23:07:34' },
        { y: 10, x: 6.5, t_seconds: 23390, t_absolute: '2026-09-26T03:52:53' },
      ],
      class: 'histogram',
    },
  ],
  xlabel: 'Time since earthquake (hours)',
  ylabel: 'Number of responses',
  title: 'Responses vs. Time Plot',
  preferred_unit: 'hours',
};

const DYFI_ZIP_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[166.4, -22.3], [166.5, -22.3], [166.5, -22.2], [166.4, -22.2], [166.4, -22.3]],
        ],
      },
      properties: { nresp: 9, name: 'Nouméa, Sud, New Caledonia', cdi: 3, dist: 249 },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[167.0, -21.6], [167.1, -21.6], [167.1, -21.5], [167.0, -21.5], [167.0, -21.6]],
        ],
      },
      properties: { nresp: 2, name: 'Tadine, Loyalty Islands, New Caledonia', cdi: 5, dist: 80 },
    },
  ],
};

/** Path-aware fetch mock: summary feeds by host, DYFI hops by path. */
function mockFetchDyfi({ detail = DYFI_DETAIL_FIXTURE, detailStatus = 200 } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/fdsnws/event/1/query')) {
      if (detailStatus !== 200) return new Response('down', { status: detailStatus });
      return new Response(JSON.stringify(detail), { status: 200 });
    }
    if (u.includes('dyfi_plot_numresp.json')) {
      return new Response(JSON.stringify(DYFI_NUMRESP_FIXTURE), { status: 200 });
    }
    if (u.includes('dyfi_zip.geojson')) {
      return new Response(JSON.stringify(DYFI_ZIP_FIXTURE), { status: 200 });
    }
    const host = new URL(u).hostname;
    if (host === 'earthquake.usgs.gov') {
      return new Response(JSON.stringify(USGS_DYFI_SUMMARY), { status: 200 });
    }
    const body = ALL_BODIES[host];
    if (body === undefined) return new Response('down', { status: 503 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

test('parseUsgs carries felt/cdi for DYFI candidate selection', () => {
  const out = parseUsgs(USGS_DYFI_SUMMARY);
  const felt = out.find((q) => q.id === 'usgs:us6000txpi');
  assert.equal(felt.felt, 11);
  assert.equal(felt.cdi, 6.9);
  assert.equal(out.find((q) => q.id === 'usgs:us7000ti1p').felt, undefined);
});

test('selectDyfiCandidates ranks by felt then mag, filters non-usgs, caps', () => {
  const list = [
    { id: 'usgs:a', felt: 2, mag: 5.0 },
    { id: 'usgs:b', felt: 11, mag: 6.6 },
    { id: 'jma:c', felt: 99, mag: 9.0 },
    { id: 'usgs:d', mag: 7.0 },
    { id: 'usgs:e', felt: 2, mag: 6.0 },
  ];
  const out = selectDyfiCandidates(list, 3);
  assert.deepEqual(
    out.map((q) => q.id),
    ['usgs:b', 'usgs:e', 'usgs:a'],
  );
  assert.equal(selectDyfiCandidates([], 3).length, 0);
});

test('parseDyfiDetail extracts the newest product content URLs', () => {
  const p = parseDyfiDetail(DYFI_DETAIL_FIXTURE);
  assert.equal(p.code, 'us6000txpi');
  assert.equal(p.source, 'us');
  assert.equal(p.updateTimeIso, new Date(1790395024448).toISOString());
  assert.ok(p.numrespUrl.endsWith('dyfi_plot_numresp.json'));
  assert.ok(p.zipUrl.endsWith('dyfi_zip.geojson'));
});

test('parseDyfiDetail returns null without a dyfi product', () => {
  assert.equal(
    parseDyfiDetail({ type: 'Feature', properties: { products: { shakemap: [] } } }),
    null,
  );
  assert.equal(parseDyfiDetail(USGS_FIXTURE), null); // summary feed carries no products
  assert.equal(parseDyfiDetail(null), null);
});

test('parseDyfiDetail tolerates a FeatureCollection detail', () => {
  const fc = { type: 'FeatureCollection', features: [DYFI_DETAIL_FIXTURE] };
  assert.ok(parseDyfiDetail(fc).numrespUrl.endsWith('.json'));
});

test('parseNumresp totals the cumulative histogram', () => {
  const n = parseNumresp(DYFI_NUMRESP_FIXTURE);
  assert.equal(n.totalResponses, 10);
  assert.equal(n.seriesPoints, 10);
  assert.equal(n.series[9].n, 10);
  assert.equal(n.series[0].t, '2026-09-25T21:38:05');
  assert.equal(parseNumresp({}), null);
});

test('parseDyfiZip ranks ZIPs by response count with centroids', () => {
  const locs = parseDyfiZip(DYFI_ZIP_FIXTURE);
  assert.equal(locs.length, 2);
  assert.equal(locs[0].name, 'Nouméa, Sud, New Caledonia');
  assert.equal(locs[0].nresp, 9);
  assert.equal(locs[0].cdi, 3);
  assert.ok(Math.abs(locs[0].lat - -22.26) < 0.001);
  assert.ok(Math.abs(locs[0].lon - 166.44) < 0.001);
  assert.equal(parseDyfiZip({}).length, 0);
});

test('centroidOfPolygon averages the outer ring', () => {
  assert.deepEqual(centroidOfPolygon([[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]), {
    lat: 0.8,
    lon: 0.8,
  });
  assert.equal(centroidOfPolygon(null), null);
});

test('enrichDyfi resolves the 2-hop chain for the top felt candidate', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchDyfi();
  try {
    const dyfi = await enrichDyfi(parseUsgs(USGS_DYFI_SUMMARY));
    assert.equal(dyfi.eventId, 'us6000txpi');
    assert.equal(dyfi.mag, 6.6);
    assert.equal(dyfi.feltReports, 11);
    assert.equal(dyfi.maxCdi, 6.9);
    assert.equal(dyfi.totalResponses, 10);
    assert.equal(dyfi.seriesPoints, 10);
    assert.equal(dyfi.locationsCount, 2);
    assert.equal(dyfi.locations[0].nresp, 9);
    assert.equal(
      dyfi.eventPage,
      'https://earthquake.usgs.gov/earthquakes/eventpage/us6000txpi',
    );
    assert.match(dyfi.attribution, /Did You Feel It/);
    assert.ok(dyfi.productUrl.endsWith('dyfi_plot_numresp.json'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('enrichDyfi returns null when no candidate has a DYFI product', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchDyfi({
    detail: { type: 'Feature', properties: { products: {} } },
  });
  try {
    assert.equal(await enrichDyfi(parseUsgs(USGS_FIXTURE)), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('enrichDyfi throws when every candidate errors', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchDyfi({ detailStatus: 503 });
  try {
    await assert.rejects(() => enrichDyfi(parseUsgs(USGS_FIXTURE)), /dyfi_upstream_503/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler enriches /api/quakes with DYFI when a felt event is present', async () => {
  clearCaches();
  const calls = mount(quakesProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchDyfi();
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/quakes'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.ok(payload.dyfi);
    assert.equal(payload.dyfi.eventId, 'us6000txpi');
    assert.equal(payload.dyfi.totalResponses, 10);
    assert.equal(payload.sources.dyfi.ok, true);
    assert.equal(payload.sources.dyfi.count, 10);
    assert.equal(payload.sources.dyfi.eventId, 'us6000txpi');
    assert.ok(payload.sources.usgs.ok); // core feeds unaffected
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler stays 200 with an honest dyfi error when DYFI hops fail', async () => {
  clearCaches();
  const calls = mount(quakesProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchDyfi({ detailStatus: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/quakes'), res);
    assert.equal(res.statusCode, 200); // DYFI never 502s the snapshot
    const payload = JSON.parse(res.body);
    assert.equal(payload.dyfi, null);
    assert.equal(payload.sources.dyfi.ok, false);
    assert.match(payload.sources.dyfi.error, /dyfi_upstream_503/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler reports no DYFI product honestly when candidates lack one', async () => {
  clearCaches();
  const calls = mount(quakesProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchDyfi({
    detail: { type: 'Feature', properties: { products: {} } },
  });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/quakes'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.dyfi, null);
    assert.equal(payload.sources.dyfi.ok, true);
    assert.match(payload.sources.dyfi.note, /no DYFI product/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
