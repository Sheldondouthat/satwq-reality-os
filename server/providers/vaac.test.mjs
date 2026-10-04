import assert from 'node:assert/strict';
import test from 'node:test';
import { vaacProxy } from './vaac.js';

/** Minimal req/res doubles for the provider handler. */
function fakeReq(url, method = 'GET') {
  const listeners = {};
  return {
    method,
    url,
    on: (event, fn) => { listeners[event] = fn; },
    removeListener: () => {},
    headers: {},
  };
}

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

async function callProvider(url) {
  const provider = vaacProxy();
  const calls = [];
  const middlewares = { use: (route, handler) => calls.push({ route, handler }) };
  provider.configureServer({ middlewares });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/api/vaac');
  const req = fakeReq(url);
  const res = fakeRes();
  await calls[0].handler(req, res);
  return res;
}

test('vaacProxy mounts /api/vaac on both server shapes', () => {
  const provider = vaacProxy();
  assert.equal(provider.name, 'vaac');
  const seen = [];
  const middlewares = { use: (route) => seen.push(route) };
  provider.configureServer({ middlewares });
  provider.configurePreviewServer({ middlewares });
  assert.deepEqual(seen, ['/api/vaac', '/api/vaac']);
});

test('vaacProxy rejects non-allow-listed advisory URLs with 403', async () => {
  const res = await callProvider('/api/vaac?u=https://evil.example.com/svd/vaac/data/TextData/x');
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /vaac_forbidden/);
});

test('vaacProxy rejects wrong-path advisory URLs with 403', async () => {
  const res = await callProvider('/api/vaac?u=https://ds.data.jma.go.jp/other/path.html');
  assert.equal(res.statusCode, 403);
});

test('vaacProxy rejects non-GET with 405', async () => {
  const provider = vaacProxy();
  let handler = null;
  provider.configureServer({ middlewares: { use: (_r, h) => { handler = h; } } });
  const req = fakeReq('/api/vaac', 'POST');
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

test('vaacProxy 200 carries X-Upstream-Fetched-At (staleness signal for the HTML passthrough)', async () => {
  const realFetch = globalThis.fetch;
  const html = '<html><body>VAAC list</body></html>';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  });
  try {
    const res = await callProvider('/api/vaac');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, html);
    const ts = res.headers['X-Upstream-Fetched-At'];
    assert.ok(ts, 'header present');
    const d = new Date(ts);
    assert.ok(!Number.isNaN(d.getTime()), 'header is a valid ISO timestamp');
    assert.ok(Date.now() - d.getTime() < 60_000, 'timestamp is serve-time fresh');
  } finally {
    globalThis.fetch = realFetch;
  }
});
