import assert from 'node:assert/strict';
import test from 'node:test';
import { ioosProxy, _ioosInternals } from './ioos.js';

const {
  indexQueryUrl,
  trackQueryUrl,
  infoUrl,
  parseTabledap,
  latestTrackPoint,
  dedupeSensors,
  coastwatchProductId,
  clearCaches,
} = _ioosInternals;

const NOW_MS = Date.parse('2026-09-27T21:07:00Z');

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

function fakeReq(method = 'GET') {
  return { method, url: '/api/ioos' };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

// ——— fixtures (shapes verified against the live ERDDAP hosts 2026-09-27) ———

const IDX_COLS = ['datasetID', 'title', 'minTime', 'maxTime', 'minLatitude', 'maxLatitude', 'minLongitude', 'maxLongitude'];

const GLIDER_INDEX = {
  table: {
    columnNames: IDX_COLS,
    rows: [
      ['sp028-20260827T1543', 'sp028-20260827T1543', '2026-08-27T15:43:00Z', '2026-09-27T19:59:00Z', 38.0, 39.0, -124.0, -123.0],
      ['sg677-20260921T0000', 'sg677-20260921T0000', '2026-09-21T00:00:00Z', '2026-09-27T19:42:31Z', 34.0, 35.0, -121.0, -120.0],
    ],
  },
};

const TRACK = {
  table: {
    columnNames: ['time', 'latitude', 'longitude'],
    rows: [
      ['2026-09-27T18:00:00Z', 38.45, -123.43],
      ['2026-09-27T19:59:00Z', 38.457825, -123.428075],
      ['2026-09-27T12:00:00Z', 38.44, -123.44], // out of order — max-time wins
      ['2026-09-27T19:00:00Z', 999, -123.43], // invalid lat — skipped
    ],
  },
};

const SENSORS_INDEX = {
  table: {
    columnNames: IDX_COLS,
    rows: [
      ['ism-secoora-org_cormp_sun2', '(41024 / SUN2) Sunset Nearshore Met and Water, NC', '2004-10-23T00:00:40Z', '2026-09-27T18:08:00Z', 34.68, 34.68, -76.52, -76.52],
      ['org_cormp_sun2', '(41024 / SUN2) Sunset Nearshore Met and Water, NC', '2004-10-23T00:00:40Z', '2026-09-27T20:08:00Z', 34.68, 34.68, -76.52, -76.52],
      ['noaa_nos_co_ops_9414750', 'Alameda, CA (AAMC1)', '2000-01-01T00:00:00Z', '2026-10-04T19:00:00Z', 37.7717, 37.7717, -122.3, -122.3],
    ],
  },
};

// ——— coastwatch fixture (shape verified against the live host 2026-09-28) ———

const COASTWATCH_INDEX = {
  table: {
    columnNames: IDX_COLS,
    rows: [
      ['NCEP_Global_Best', 'NCEP Global Forecast System Best Time Series', '2026-09-21T15:00:00Z', '2026-10-06T15:00:00Z', -90, 90, -180, 180],
      ['wvcharmV3_3day', 'C-HARM v3 3-Day Forecast', '2026-09-28T12:00:00Z', '2026-09-30T12:00:00Z', 32.0, 49.0, -128.0, -116.0],
      // LonPM180 mirror: same product, 0..360 longitude convention → different bbox,
      // so only the product-ID normalizer merges it (not the title+center key).
      ['wvcharmV3_3day_LonPM180', 'C-HARM v3 3-Day Forecast', '2026-09-28T12:00:00Z', '2026-09-30T12:00:00Z', 32.0, 49.0, 232.0, 244.0],
      ['cwwcNDBCMet', 'NDBC Meteorological and Oceanographic data', '2026-09-21T23:10:00Z', '2026-09-27T18:00:00Z', -80, 80, -180, 180],
      ['ucsdHfrP2', 'HF Radar - US West Coast (UCSD) 2km', '2026-09-27T20:00:00Z', '2026-09-27T19:00:00Z', 32.0, 42.0, -128.0, -117.0],
      ['ucsdHfrP2_Lon0360', 'HF Radar - US West Coast (UCSD) 2km', '2026-09-27T20:00:00Z', '2026-09-27T17:00:00Z', 32.0, 42.0, 232.0, 243.0],
    ],
  },
};

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  };
}

function failResponse(status = 503) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

/** Mock global fetch, routing on URL substrings. `down` = URL substrings that fail. */
function mockFetch({ down = [], seen = [] } = {}) {
  return async (url, options) => {
    const u = String(url);
    seen.push({ url: u, options });
    if (down.some((d) => u.includes(d))) return failResponse(503);
    if (u.includes('gliders.ioos.us/erddap/tabledap/allDatasets')) return jsonResponse(GLIDER_INDEX);
    if (u.includes('gliders.ioos.us/erddap/tabledap/')) return jsonResponse(TRACK);
    if (u.includes('erddap.sensors.ioos.us/erddap/tabledap/allDatasets')) return jsonResponse(SENSORS_INDEX);
    if (u.includes('coastwatch.pfeg.noaa.gov/erddap/tabledap/allDatasets')) return jsonResponse(COASTWATCH_INDEX);
    throw new Error(`unexpected url ${u}`);
  };
}

// ——— unit tests ———

test('indexQueryUrl builds a bounded, time-constrained, sorted ERDDAP query', () => {
  const url = indexQueryUrl('https://gliders.ioos.us/erddap', 14, 20, NOW_MS);
  assert.ok(url.startsWith('https://gliders.ioos.us/erddap/tabledap/allDatasets.json?'));
  assert.ok(url.includes('datasetID,title,minTime,maxTime,minLatitude,maxLatitude,minLongitude,maxLongitude'));
  assert.ok(url.includes(encodeURIComponent('2026-09-13T21:07:00.000Z'))); // now-14d
  assert.ok(url.includes('orderByDescending('));
  assert.ok(url.includes('orderByLimit('));
});

test('trackQueryUrl targets one mission with a 24h window', () => {
  const url = trackQueryUrl('sp028-20260827T1543', NOW_MS);
  assert.ok(url.includes('/tabledap/sp028-20260827T1543.json?time,latitude,longitude'));
  assert.ok(url.includes(encodeURIComponent('2026-09-26T21:07:00.000Z')));
});

test('infoUrl points at the ERDDAP dataset info page', () => {
  assert.equal(
    infoUrl('https://gliders.ioos.us/erddap', 'sp028-20260827T1543'),
    'https://gliders.ioos.us/erddap/info/sp028-20260827T1543/index.html',
  );
});

test('parseTabledap maps columnNames+rows to objects, throws on bad shape', () => {
  const rows = parseTabledap(GLIDER_INDEX);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].datasetID, 'sp028-20260827T1543');
  assert.equal(rows[0].maxTime, '2026-09-27T19:59:00Z');
  assert.throws(() => parseTabledap({}), /unexpected_tabledap/);
  assert.throws(() => parseTabledap({ table: {} }), /unexpected_tabledap/);
});

test('latestTrackPoint takes the max-time row and skips invalid coords', () => {
  const pt = latestTrackPoint(parseTabledap(TRACK));
  assert.deepEqual(pt, { time: '2026-09-27T19:59:00.000Z', lat: 38.4578, lon: -123.4281 });
  assert.equal(latestTrackPoint([]), null);
  assert.equal(latestTrackPoint(null), null);
});

test('dedupeSensors merges station mirrors and flags forecasts', () => {
  const out = dedupeSensors(parseTabledap(SENSORS_INDEX), NOW_MS);
  assert.equal(out.length, 2); // SUN2 mirrors collapse to one
  const sun2 = out.find((d) => d.title.includes('SUN2'));
  assert.ok(sun2);
  assert.equal(sun2.datasetID, 'org_cormp_sun2'); // later maxTime wins
  assert.equal(sun2.maxTime, '2026-09-27T20:08:00Z');
  assert.equal(sun2.lat, 34.68);
  assert.equal(sun2.lon, -76.52);
  assert.equal(sun2.isForecast, false);
  const alameda = out.find((d) => d.datasetID === 'noaa_nos_co_ops_9414750');
  assert.equal(alameda.isForecast, true); // maxTime 2026-10-04 > now+6h
  assert.ok(alameda.infoUrl.includes('erddap.sensors.ioos.us/erddap/info/'));
});

test('coastwatchProductId strips longitude-convention suffixes only', () => {
  assert.equal(coastwatchProductId('wvcharmV3_3day_LonPM180'), 'wvcharmV3_3day');
  assert.equal(coastwatchProductId('ucsdHfrP2_Lon0360'), 'ucsdHfrP2');
  assert.equal(coastwatchProductId('NCEP_Global_Best'), 'NCEP_Global_Best');
  assert.equal(coastwatchProductId('erdMH1sstd1day_R2022NRTNotMasked'), 'erdMH1sstd1day_R2022NRTNotMasked');
});

test('dedupeSensors merges CoastWatch lon-convention mirrors and flags forecasts', () => {
  const out = dedupeSensors(
    parseTabledap(COASTWATCH_INDEX),
    NOW_MS,
    'https://coastwatch.pfeg.noaa.gov/erddap',
    coastwatchProductId,
  );
  assert.equal(out.length, 4); // two mirror pairs collapse via the ID normalizer
  const charm = out.find((d) => d.datasetID === 'wvcharmV3_3day');
  assert.ok(charm);
  assert.ok(charm.infoUrl.includes('coastwatch.pfeg.noaa.gov/erddap/info/wvcharmV3_3day/'));
  assert.equal(charm.isForecast, true); // 2026-09-30 > now+6h
  const hfr = out.find((d) => d.datasetID === 'ucsdHfrP2');
  assert.ok(hfr);
  assert.equal(hfr.maxTime, '2026-09-27T19:00:00Z'); // later of the pair wins
  assert.equal(hfr.isForecast, false);
  const ncep = out.find((d) => d.datasetID === 'NCEP_Global_Best');
  assert.ok(ncep);
  assert.equal(ncep.isForecast, true); // 2026-10-06 > now+6h
});

// ——— handler tests ———

test('ioosProxy mounts /api/ioos on both server shapes', () => {
  const routes = mount(ioosProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/ioos', '/api/ioos']);
});

test('handler serves gliders + sensors with paced sequential fetches', async () => {
  clearCaches();
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ seen });
  try {
    const calls = mount(ioosProxy({ now: () => NOW_MS }));
    const res = fakeRes();
    await calls[0].handler(fakeReq('GET'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.ok(payload.generatedAt);
    // gliders: 2 missions, each with a latest position from its track hop
    assert.equal(payload.gliders.activeMissions, 2);
    assert.equal(payload.gliders.missions[0].datasetID, 'sp028-20260827T1543');
    assert.deepEqual(payload.gliders.missions[0].latest, {
      time: '2026-09-27T19:59:00.000Z',
      lat: 38.4578,
      lon: -123.4281,
    });
    assert.deepEqual(payload.gliders.missions[0].bbox, {
      minLat: 38, maxLat: 39, minLon: -124, maxLon: -123,
    });
    // sensors: 3 index rows → 2 deduped stations
    assert.equal(payload.sensors.activeDatasets, 2);
    // coastwatch: 6 index rows → 4 deduped products (LonPM180/Lon0360 mirrors merged)
    assert.equal(payload.coastwatch.activeProducts, 4);
    assert.ok(payload.sources.coastwatch.ok);
    assert.match(payload.attribution, /CoastWatch/);
    assert.ok(payload.sources.gliders.ok);
    assert.ok(payload.sources.sensors.ok);
    assert.match(payload.attribution, /IOOS/);
    // pacing: 1 glider index + 2 track hops + 1 sensor index + 1 coastwatch index = 5 sequential calls
    assert.equal(seen.length, 5);
    assert.ok(seen.every((s) => s.options.redirect === 'follow'));
    assert.match(res.headers['Cache-Control'], /max-age=600/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler degrades honestly when the glider host is down', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ down: ['gliders.ioos.us'] });
  try {
    const calls = mount(ioosProxy({ now: () => NOW_MS }));
    const res = fakeRes();
    await calls[0].handler(fakeReq('GET'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.sources.gliders.ok, false);
    assert.match(payload.sources.gliders.error, /503/);
    assert.equal(payload.sources.sensors.ok, true);
    assert.equal(payload.sensors.activeDatasets, 2);
    assert.equal(payload.sources.coastwatch.ok, true);
    assert.equal(payload.coastwatch.activeProducts, 4);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a failed per-mission track hop degrades to latest:null, not a 502', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  // fail only the per-mission track queries, keep the index live
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes('gliders.ioos.us/erddap/tabledap/') && !u.includes('allDatasets')) {
      return failResponse(503);
    }
    return mockFetch()(u, options);
  };
  try {
    const calls = mount(ioosProxy({ now: () => NOW_MS }));
    const res = fakeRes();
    await calls[0].handler(fakeReq('GET'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.sources.gliders.ok, true);
    assert.ok(payload.gliders.missions.every((m) => m.latest === null));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when all three ERDDAP hosts are down', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ down: ['gliders.ioos.us', 'erddap.sensors.ioos.us', 'coastwatch.pfeg.noaa.gov'] });
  try {
    const calls = mount(ioosProxy({ now: () => NOW_MS }));
    const res = fakeRes();
    await calls[0].handler(fakeReq('GET'), res);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error, 'ioos_unavailable');
    assert.match(JSON.parse(res.body).detail, /all_upstream_down/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(ioosProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});
