import assert from 'node:assert/strict';
import test from 'node:test';
import { volcanoProxy, _volcanoInternals } from './volcano.js';

const { trimGeonetVolcano, parseAvoCards, buildActive, trimVolcanoPayload } = _volcanoInternals;

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

const SAMPLE_GEONET = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [175.896, -38.784] },
      properties: {
        acc: 'Green',
        activity: 'No volcanic unrest.',
        hazards: 'Volcanic environment hazards.',
        level: 0,
        volcanoID: 'taupo',
        volcanoTitle: 'Taupo',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [177.183, -38.12] },
      properties: {
        acc: 'Yellow',
        activity: 'Moderate to heightened volcanic unrest.',
        hazards: 'Eruption hazards.',
        level: 2,
        volcanoID: 'whiteisland',
        volcanoTitle: 'White Island',
      },
    },
  ],
};

const SAMPLE_AVO = `
<div class="alert-level"><a href="/volcano/alertLevels" class="plain-link">
<h3>Alert Level: WATCH</h3></a></div>
<div class="color-code"><a href="/volcano/alertLevels" class="plain-link">
<h3>Color Code:\tORANGE</h3></a></div>
<label for="card4765" class="button volc-flip" aria-hidden="true" data-point="52.0765,-176.1109">Details</label>
<div class="back"><div class="inner"><div class="location"><h4>Aleutians</h4>(52.0765, -176.1109)</div>
<div class="region"><a href="/volcano/great-sitkin/activity" class="uncolored-link"><h3>Great Sitkin</h3></a></div>
`;

test('volcanoProxy mounts /api/volcano on both server shapes', () => {
  const routes = mount(volcanoProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/volcano', '/api/volcano']);
});

test('trimGeonetVolcano keeps level, color and activity text', () => {
  const v = trimGeonetVolcano(SAMPLE_GEONET.features[1]);
  assert.equal(v.id, 'whiteisland');
  assert.equal(v.level, 2);
  assert.equal(v.color, 'Yellow');
  assert.equal(v.lat, -38.12);
  assert.match(v.activity, /heightened/);
});

test('parseAvoCards captures elevated cards with coords and slug URL', () => {
  const rows = parseAvoCards(SAMPLE_AVO);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'great-sitkin');
  assert.equal(rows[0].name, 'Great Sitkin');
  assert.equal(rows[0].alertLevel, 'WATCH');
  assert.equal(rows[0].colorCode, 'ORANGE');
  assert.equal(rows[0].lat, 52.0765);
  assert.equal(rows[0].url, 'https://avo.alaska.edu/volcano/great-sitkin/activity');
});

test('parseAvoCards returns [] on unrelated markup (honest empty)', () => {
  assert.deepEqual(parseAvoCards('<html><body>no cards here</body></html>'), []);
});

test('buildActive keeps White Island, drops Green Taupo, adds AVO row', () => {
  const geonet = SAMPLE_GEONET.features.map(trimGeonetVolcano);
  const avo = parseAvoCards(SAMPLE_AVO);
  const active = buildActive(geonet, avo);
  const ids = active.map((a) => a.id);
  assert.ok(ids.includes('geonet:whiteisland'));
  assert.ok(!ids.includes('geonet:taupo'));
  assert.ok(ids.includes('avo:great-sitkin'));
});

test('trimVolcanoPayload records per-source failures as warnings', async () => {
  const payload = await trimVolcanoPayload(
    { status: 'error', error: 'boom', count: 0, volcanoes: [] },
    { status: 'ok', count: 1, volcanoes: parseAvoCards(SAMPLE_AVO), coverageNote: 'n' },
  );
  assert.deepEqual(payload.sources, { geonet: 'error', avo: 'ok' });
  assert.match(payload.warnings.join(' '), /geonet_unavailable/);
  assert.equal(payload.activeCount, 1);
});

test('handler serves merged snapshot with mocked fetch', async () => {
  const calls = mount(volcanoProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    url.includes('geonet')
      ? new Response(JSON.stringify(SAMPLE_GEONET), { status: 200 })
      : new Response(SAMPLE_AVO, { status: 200, headers: { 'Content-Type': 'text/html' } });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/volcano'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.geonet.count, 2);
    assert.equal(payload.avo.count, 1);
    assert.equal(payload.activeCount, 2); // White Island + Great Sitkin
    assert.match(res.headers['Cache-Control'], /max-age=600/);
  } finally {
    globalThis.fetch = realFetch;
    _volcanoInternals.clearCaches();
  }
});

test('handler degrades per-source instead of 500ing when one upstream fails', async () => {
  _volcanoInternals.clearCaches();
  const calls = mount(volcanoProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    url.includes('geonet')
      ? new Response('down', { status: 503 })
      : new Response(SAMPLE_AVO, { status: 200, headers: { 'Content-Type': 'text/html' } });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/volcano'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.sources.geonet, 'error');
    assert.equal(payload.avo.count, 1);
    assert.match(payload.warnings.join(' '), /geonet_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
    _volcanoInternals.clearCaches();
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(volcanoProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/volcano', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
