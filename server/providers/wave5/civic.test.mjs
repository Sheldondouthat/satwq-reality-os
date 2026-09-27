import assert from 'node:assert/strict';
import test from 'node:test';
import { civicProxy, _civicInternals } from './civic.js';

const { trimFederalRegister, trimHnItem, trim311, trimCivicPayload } = _civicInternals;

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

const FR_DOC = {
  document_number: '2026-12345',
  type: 'Rule',
  title: 'Endangered and Threatened Wildlife',
  abstract: 'We propose to list the monarch butterfly.',
  publication_date: '2026-09-27',
  html_url: 'https://www.federalregister.gov/documents/2026/09/27/2026-12345/x',
};

const HN_ITEM = {
  id: 45450000,
  type: 'story',
  title: 'A better kind of static site generator',
  url: 'https://example.com/gen',
  score: 512,
  by: 'pg',
  time: 1759000000,
  descendants: 128,
};

const ROW_311 = {
  unique_key: '98765432',
  created_date: '2026-09-27T09:12:00.000',
  complaint_type: 'Noise - Street/Sidewalk',
  descriptor: 'Loud Music/Party',
  agency: 'NYPD',
  borough: 'BROOKLYN',
  latitude: '40.6782',
  longitude: '-73.9442',
};

test('civicProxy mounts /api/civic on both server shapes', () => {
  const routes = mount(civicProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/civic', '/api/civic']);
});

test('trimFederalRegister keeps document fields', () => {
  const d = trimFederalRegister(FR_DOC);
  assert.equal(d.feed, 'federal-register');
  assert.equal(d.id, '2026-12345');
  assert.equal(d.kind, 'Rule');
  assert.equal(d.url, FR_DOC.html_url);
});

test('trimHnItem keeps story fields and converts unix time', () => {
  const s = trimHnItem(HN_ITEM);
  assert.equal(s.feed, 'hacker-news');
  assert.equal(s.id, '45450000');
  assert.equal(s.score, 512);
  assert.equal(s.published, new Date(1759000000 * 1000).toISOString());
});

test('trimHnItem falls back to HN thread URL when no link', () => {
  const s = trimHnItem({ id: 1, title: 'ask', type: 'story' });
  assert.equal(s.url, 'https://news.ycombinator.com/item?id=1');
});

test('trim311 keeps complaint fields and coords', () => {
  const r = trim311(ROW_311);
  assert.equal(r.feed, 'nyc-311');
  assert.equal(r.kind, 'Noise - Street/Sidewalk');
  assert.equal(r.lat, 40.6782);
  assert.equal(r.lon, -73.9442);
});

test('trimCivicPayload merges items and tracks degraded sources', () => {
  const payload = trimCivicPayload([
    { name: 'federal-register', result: [trimFederalRegister(FR_DOC)] },
    { name: 'hacker-news', result: new Error('boom') },
    { name: 'nyc-311', result: [trim311(ROW_311)] },
  ]);
  assert.equal(payload.count, 2);
  assert.deepEqual(payload.degradedSources, ['hacker-news']);
  assert.ok(payload.attribution.includes('Federal Register'));
});

test('handler serves merged snapshot with mocked fetch', async () => {
  _civicInternals.clearCaches();
  const calls = mount(civicProxy());
  const realFetch = globalThis.fetch;
  const fetchImpl = (url, init) => {
    assert.equal(init?.redirect, 'follow'); // workerd: 'error' throws at edge (main 2ec4053)
    const u = String(url);
    let body = null;
    if (u.includes('/api/v1/documents.json')) body = { results: [FR_DOC] };
    else if (u.endsWith('/v0/topstories.json')) body = [45450000];
    else if (u.includes('/v0/item/')) body = HN_ITEM;
    else if (u.includes('data.cityofnewyork.us')) body = [ROW_311];
    assert.ok(body, `unexpected upstream URL ${u}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  globalThis.fetch = fetchImpl;
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/civic'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 3);
    assert.deepEqual(payload.degradedSources, []);
    assert.equal(payload.items[0].feed, 'federal-register');
    assert.equal(payload.items[1].feed, 'hacker-news');
    assert.equal(payload.items[2].feed, 'nyc-311');
    assert.match(res.headers['Cache-Control'], /max-age=900/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler degrades gracefully when one source is down', async () => {
  _civicInternals.clearCaches();
  const calls = mount(civicProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('hacker-news')) return new Response('down', { status: 503 });
    if (u.includes('/api/v1/documents.json')) return new Response(JSON.stringify({ results: [FR_DOC] }), { status: 200 });
    if (u.includes('data.cityofnewyork.us')) return new Response(JSON.stringify([ROW_311]), { status: 200 });
    throw new Error(`unexpected ${u}`);
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/civic'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload.degradedSources, ['hacker-news']);
    assert.equal(payload.count, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when all upstreams are down', async () => {
  _civicInternals.clearCaches();
  const calls = mount(civicProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/civic'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /civic_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(civicProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/civic', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
