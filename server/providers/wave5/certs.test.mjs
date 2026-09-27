import assert from 'node:assert/strict';
import test from 'node:test';
import { certsProxy, _certsInternals } from './certs.js';

const { parseQueryParam, crtshUrl, issuerLabel, trimCert, trimCertsPayload, clearCaches } = _certsInternals;

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

function fakeReq(url = '/api/certs', method = 'GET') {
  return { method, url, originalUrl: url, on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

const SAMPLE_UPSTREAM = [
  {
    issuer_ca_id: 204407,
    issuer_name: 'C=GB, O=Sectigo Limited, CN=Sectigo Public Server Authentication CA DV E36',
    common_name: 'example.com',
    name_value: '*.example.com\nexample.com',
    id: 29557945233,
    not_before: '2026-09-24T00:00:00',
    not_after: '2026-12-21T09:32:54',
    serial_number: '2caeeaf0743459d7e5f82a75123c58f3',
  },
];

test('certsProxy mounts /api/certs on both server shapes', () => {
  const routes = mount(certsProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/certs', '/api/certs']);
});

test('parseQueryParam defaults, validates, rejects garbage', () => {
  assert.equal(parseQueryParam({}), 'example.com');
  assert.equal(parseQueryParam({ q: 'Some.IO' }), 'some.io');
  assert.equal(parseQueryParam({ q: '%.example.com' }), '%.example.com');
  assert.throws(() => parseQueryParam({ q: 'not a domain!!' }), /certs_bad_query/);
  assert.throws(() => parseQueryParam({ q: 'x'.repeat(300) }), /certs_bad_query/);
});

test('crtshUrl encodes the query', () => {
  assert.equal(crtshUrl('example.com'), 'https://crt.sh/?q=example.com&output=json');
  assert.match(crtshUrl('%.example.com'), /q=%25\.example\.com/);
});

test('issuerLabel extracts the CN', () => {
  assert.equal(
    issuerLabel('C=GB, O=Sectigo Limited, CN=Sectigo Public Server Authentication CA DV E36'),
    'Sectigo Public Server Authentication CA DV E36',
  );
  assert.equal(issuerLabel(null), '');
});

test('trimCert normalizes a row with expiry countdown', () => {
  const c = trimCert(SAMPLE_UPSTREAM[0]);
  assert.equal(c.commonName, 'example.com');
  assert.deepEqual(c.names, ['*.example.com', 'example.com']);
  assert.equal(c.issuer, 'Sectigo Public Server Authentication CA DV E36');
  assert.equal(c.id, 29557945233);
  assert.ok(Number.isInteger(c.expiresInDays));
});

test('trimCertsPayload caps rows aggressively and flags it', () => {
  const big = Array.from({ length: 120 }, (_, i) => ({
    ...SAMPLE_UPSTREAM[0],
    id: i,
    common_name: `sub${i}.example.com`,
  }));
  const p = trimCertsPayload(big, 'example.com');
  assert.equal(p.certs.length, 50);
  assert.equal(p.capped, true);
  assert.equal(p.value, 50);
  assert.equal(p.unit, 'certificates');
  assert.equal(p.query, 'example.com');
  assert.match(p.attribution, /crt\.sh/);
});

test('trimCertsPayload throws 502 on bad upstream shape', () => {
  assert.throws(() => trimCertsPayload({ foo: 1 }, 'x'), /certs_upstream_shape/);
});

test('handler serves trimmed payload with mocked fetch', async () => {
  const calls = mount(certsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(SAMPLE_UPSTREAM), { status: 200 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/certs?q=example.com'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.certs.length, 1);
    assert.equal(payload.certs[0].commonName, 'example.com');
    assert.match(res.headers['Cache-Control'], /max-age=3600/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects a bad q with 400, never hits upstream', async () => {
  const calls = mount(certsProxy());
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return new Response('[]', { status: 200 }); };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/certs?q=bad!!query'), res);
    assert.equal(res.statusCode, 400);
    assert.equal(fetched, false);
    assert.match(res.body, /certs_bad_query/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when upstream is down', async () => {
  clearCaches();
  const calls = mount(certsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/certs?q=example.com'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /certs_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(certsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/certs', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
