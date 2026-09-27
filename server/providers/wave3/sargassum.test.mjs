import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SARGASSUM_IMAGE_ROUTE,
  SARGASSUM_REGIONS,
  SARGASSUM_ROUTE,
  describeSargassum,
  parseAnalysisDate,
  regionsPresent,
  sargassumProxy,
} from './sargassum.js';

const PAGE_FIXTURE = `
<html><body>
<select>
<option value="SIR_20260918">x</option>
<option value="SIR_20260925" selected>Sep 25</option>
</select>
<img src="./images/20260925/GOMF.png" alt="Gulf of America">
<img src="./images/20260925/CA.png" alt="Central America">
<img src="./images/20260925/GREATER.png" alt="g">
<img src="./images/20260925/LESSER.png" alt="g">
<img src="./images/20260925/SA.png" alt="g">
<a href="./KMZ/sargassum_risk_20260925.kmz">kmz</a>
<a href="./PDF/SIR_20260925.pdf">pdf</a>
</body></html>`;

test('parseAnalysisDate reads the selected option', () => {
  assert.equal(parseAnalysisDate(PAGE_FIXTURE), '20260925');
});

test('parseAnalysisDate falls back to the newest image dir', () => {
  const html = '<img src="./images/20260910/GOMF.png"><img src="./images/20260911/GOMF.png">';
  assert.equal(parseAnalysisDate(html), '20260911');
});

test('parseAnalysisDate returns null when nothing matches', () => {
  assert.equal(parseAnalysisDate('<html></html>'), null);
  assert.equal(parseAnalysisDate(null), null);
});

test('regionsPresent lists only regions with images on the page', () => {
  assert.deepEqual(regionsPresent(PAGE_FIXTURE, '20260925'),
    ['GOMF', 'CA', 'GREATER', 'LESSER', 'SA']);
  assert.deepEqual(regionsPresent('<img src="./images/20260925/GOMF.png">', '20260925'), ['GOMF']);
  assert.deepEqual(regionsPresent(PAGE_FIXTURE, 'bogus'), []);
  assert.deepEqual(regionsPresent(PAGE_FIXTURE, '20260918'), [], 'stale date has no images');
});

test('describeSargassum builds honest document', () => {
  const doc = describeSargassum({
    dateStr: '20260925',
    regions: SARGASSUM_REGIONS,
    fetchedAt: '2026-09-27T00:00:00Z',
    origin: 'http://localhost:9999',
  });
  assert.equal(doc.analysisDate, '20260925');
  assert.equal(doc.regions.length, 5);
  assert.equal(doc.regions[0].imageUrl, 'https://cwcgom.aoml.noaa.gov/SIR/images/20260925/GOMF.png');
  assert.ok(doc.regions[0].proxiedImageUrl.startsWith('http://localhost:9999/api/sargassum/image?'));
  assert.equal(doc.kmzUrl, 'https://cwcgom.aoml.noaa.gov/SIR/KMZ/sargassum_risk_20260925.kmz');
  assert.ok(doc.honesty.includes('not data'), 'honesty labels images as non-numerical');
});

function mount(proxy) {
  const handlers = new Map();
  proxy.configureServer({ middlewares: { use(r, h) { handlers.set(r, h); } } });
  return handlers;
}

function mockPageFetch(html, status = 200) {
  return async (url) => {
    if (String(url).includes('cwcgom.aoml.noaa.gov/SIR/') && !String(url).includes('images/')) {
      return { ok: status >= 200 && status < 300, status, text: async () => html };
    }
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([137, 80, 78]).buffer };
  };
}

function get(handlers, route, url = '/') {
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(s, h) { this.status = s; this.headers = h; },
      end(b) { resolve({ status: this.status, headers: this.headers, body: b }); },
    };
    handlers.get(route)({ method: 'GET', url, headers: { host: 'localhost:9999' } }, res);
  });
}

test('sargassumProxy serves the analysis document (mocked page)', async () => {
  const handlers = mount(sargassumProxy({ fetchImpl: mockPageFetch(PAGE_FIXTURE) }));
  assert.ok(handlers.has(SARGASSUM_ROUTE));
  assert.ok(handlers.has(SARGASSUM_IMAGE_ROUTE));
  const r = await get(handlers, SARGASSUM_ROUTE);
  assert.equal(r.status, 200);
  const doc = JSON.parse(r.body);
  assert.equal(doc.analysisDate, '20260925');
  assert.equal(doc.regions.length, 5);
  assert.equal(doc.stale, false);
});

test('sargassumProxy 503s when upstream is down and cache is empty', async () => {
  const handlers = mount(sargassumProxy({ fetchImpl: mockPageFetch('', 500) }));
  const r = await get(handlers, SARGASSUM_ROUTE);
  assert.equal(r.status, 503);
  assert.equal(JSON.parse(r.body).error, 'sargassum_unavailable');
});

test('image proxy allowlists date and region (SSRF guard)', async () => {
  const handlers = mount(sargassumProxy({ fetchImpl: mockPageFetch(PAGE_FIXTURE) }));
  const good = await get(handlers, SARGASSUM_IMAGE_ROUTE, '/?date=20260925&region=GOMF');
  assert.equal(good.status, 200);
  assert.equal(good.headers['Content-Type'], 'image/png');

  const badDate = await get(handlers, SARGASSUM_IMAGE_ROUTE, '/?date=../../etc&region=GOMF');
  assert.equal(badDate.status, 400);

  const badRegion = await get(handlers, SARGASSUM_IMAGE_ROUTE, '/?date=20260925&region=GOMF;rm');
  assert.equal(badRegion.status, 400);

  const badKind = await get(handlers, SARGASSUM_IMAGE_ROUTE, '/?date=20260925&region=GOMF&kind=x');
  assert.equal(badKind.status, 400);

  const bar = await get(handlers, SARGASSUM_IMAGE_ROUTE, '/?date=20260925&region=CA&kind=bar');
  assert.equal(bar.status, 200);
});
