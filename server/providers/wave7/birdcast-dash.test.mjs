import assert from 'node:assert/strict';
import test from 'node:test';
import { birdcastDashProxy, _birdcastDashInternals } from './birdcast-dash.js';

const { buildEmbedHtml, probeDashboard, pageTitleFromHead, clearCaches } = _birdcastDashInternals;

const EMBED_URL = 'https://dashboard.birdcast.org/live-maps?embed=true';

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
  return { method, url: '/api/birdcast-dash' };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

const DASH_HEAD = `<!doctype html><html><head><title>Live Migration Maps - BirdCast</title><meta charset="utf-8"></head>`;

function htmlResponse({ status = 200, body = DASH_HEAD } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name === 'content-type' ? 'text/html; charset=utf-8' : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

// ——— unit tests ———

test('pageTitleFromHead extracts the dashboard title', () => {
  assert.equal(pageTitleFromHead(DASH_HEAD), 'Live Migration Maps - BirdCast');
  assert.equal(pageTitleFromHead('<html><head></head></html>'), null);
  assert.equal(pageTitleFromHead(null), null);
});

test('buildEmbedHtml produces an iframe pointing at the embed URL', () => {
  const html = buildEmbedHtml();
  assert.match(html, /^<iframe /);
  assert.ok(html.includes(`src="${EMBED_URL}"`));
  assert.ok(html.includes('title="Live Migration Maps - BirdCast"'));
  assert.ok(html.includes('loading="lazy"'));
  assert.ok(!html.includes('""')); // no broken quoting
});

test('probeDashboard reports ok on a 200 HTML shell', async () => {
  const seen = [];
  const probe = await probeDashboard(async (url, options) => {
    seen.push({ url, options });
    return htmlResponse();
  });
  assert.equal(probe.ok, true);
  assert.equal(probe.status, 200);
  assert.equal(probe.contentType, 'text/html; charset=utf-8');
  assert.equal(probe.pageTitle, 'Live Migration Maps - BirdCast');
  assert.equal(probe.error, null);
  assert.ok(probe.checkedAt);
  assert.equal(seen[0].options.redirect, 'follow');
  assert.equal(String(seen[0].url), EMBED_URL);
});

test('probeDashboard degrades (never throws) on HTTP errors', async () => {
  const probe = await probeDashboard(async () => htmlResponse({ status: 503 }));
  assert.equal(probe.ok, false);
  assert.equal(probe.status, 503);
  assert.match(probe.error, /dashboard_http_503/);
});

test('probeDashboard degrades (never throws) on aborts', async () => {
  const probe = await probeDashboard(async () => {
    throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.status, null);
  assert.match(probe.error, /aborted/i);
});

// ——— handler tests ———

test('birdcastDashProxy mounts /api/birdcast-dash on both server shapes', () => {
  const routes = mount(birdcastDashProxy({ fetchImpl: async () => htmlResponse() })).map((c) => c.route);
  assert.deepEqual(routes, ['/api/birdcast-dash', '/api/birdcast-dash']);
});

test('handler returns embed metadata with a healthy probe', async () => {
  clearCaches();
  const calls = mount(birdcastDashProxy({ fetchImpl: async () => htmlResponse() }));
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.ok(doc.generatedAt);
  assert.equal(doc.embedUrl, EMBED_URL);
  assert.equal(doc.embedType, 'iframe');
  assert.equal(doc.title, 'Live Migration Maps - BirdCast');
  assert.ok(doc.description.length > 20);
  assert.ok(doc.embedHtml.includes('<iframe'));
  assert.ok(doc.embedHtml.includes(EMBED_URL));
  assert.equal(doc.mosaicApi, '/api/birdcast');
  assert.match(doc.attribution, /Cornell Lab/);
  assert.equal(doc.probe.ok, true);
  assert.equal(doc.probe.pageTitle, 'Live Migration Maps - BirdCast');
  assert.match(res.headers['Cache-Control'], /max-age=600/);
});

test('a failed probe still yields 200 with probe.ok:false (metadata is static)', async () => {
  clearCaches();
  const calls = mount(birdcastDashProxy({ fetchImpl: async () => { throw new Error('socket hang up'); } }));
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.probe.ok, false);
  assert.match(doc.probe.error, /socket hang up/);
  assert.equal(doc.embedUrl, EMBED_URL); // embed target still served
  assert.ok(doc.note.includes('catalog-verified'));
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(birdcastDashProxy({ fetchImpl: async () => htmlResponse() }));
  const res = fakeRes();
  await calls[0].handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});
