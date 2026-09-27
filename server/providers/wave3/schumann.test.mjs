import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCHUMANN_IMAGE_ROUTE,
  SCHUMANN_ROUTE,
  chartsReferenced,
  describeSchumann,
  schumannProxy,
} from './schumann.js';

const PAGE_FIXTURE = `<html><body>
<p><img src="http://www.vlf.it/cumiana/last_E-VLF.jpg"></p>
<p><img src="http://www.vlf.it/cumiana/last-plotted.jpg"></p>
</body></html>`;

test('chartsReferenced detects both known charts', () => {
  assert.deepEqual(chartsReferenced(PAGE_FIXTURE), ['evlf', 'plotted']);
  assert.deepEqual(chartsReferenced('<html></html>'), []);
  assert.deepEqual(chartsReferenced(null), []);
});

test('describeSchumann builds the document with proxied URLs', () => {
  const doc = describeSchumann({
    kinds: ['evlf', 'plotted'],
    fetchedAt: '2026-09-27T00:00:00Z',
    origin: 'http://localhost:9999',
  });
  assert.equal(doc.charts.length, 2);
  assert.equal(doc.charts[0].proxiedUrl, 'http://localhost:9999/api/schumann/image?kind=evlf');
  assert.ok(doc.honesty.includes('not numerical telemetry'));
});

function mount(proxy) {
  const handlers = new Map();
  proxy.configureServer({ middlewares: { use(r, h) { handlers.set(r, h); } } });
  return handlers;
}

function mockFetch(html, imgBytes = new Uint8Array([255, 216, 255])) {
  return async (url) => {
    if (String(url).includes('livedata.html')) {
      return { ok: true, status: 200, text: async () => html };
    }
    return { ok: true, status: 200, arrayBuffer: async () => imgBytes.buffer };
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

test('schumannProxy serves the chart document (mocked page)', async () => {
  const handlers = mount(schumannProxy({ fetchImpl: mockFetch(PAGE_FIXTURE) }));
  assert.ok(handlers.has(SCHUMANN_ROUTE));
  assert.ok(handlers.has(SCHUMANN_IMAGE_ROUTE));
  const r = await get(handlers, SCHUMANN_ROUTE);
  assert.equal(r.status, 200);
  const doc = JSON.parse(r.body);
  assert.equal(doc.charts.length, 2);
  assert.equal(doc.stale, false);
});

test('schumannProxy 503s when upstream is down and cache is empty', async () => {
  const handlers = mount(schumannProxy({
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }),
  }));
  const r = await get(handlers, SCHUMANN_ROUTE);
  assert.equal(r.status, 503);
});

test('image proxy allowlists chart kind (no SSRF)', async () => {
  const handlers = mount(schumannProxy({ fetchImpl: mockFetch(PAGE_FIXTURE) }));
  const good = await get(handlers, SCHUMANN_IMAGE_ROUTE, '/?kind=evlf');
  assert.equal(good.status, 200);
  assert.equal(good.headers['Content-Type'], 'image/jpeg');

  const evil = await get(handlers, SCHUMANN_IMAGE_ROUTE, '/?kind=//evil/x');
  assert.equal(evil.status, 400);
  const empty = await get(handlers, SCHUMANN_IMAGE_ROUTE, '/');
  assert.equal(empty.status, 400);
});
