import assert from 'node:assert/strict';
import test from 'node:test';
import { birdcastProxy, _birdcastInternals } from './birdcast.js';

const { listingUrl, parseS3Listing, pickLatest, clearCaches } = _birdcastInternals;

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
  return { method, url: '/api/birdcast' };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

// ——— fixtures (S3 ListBucketResult shape) ———

const LISTING_TODAY = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>is-birdcast-observed-prod</Name>
  <Prefix>mosaic/2026/09/27/</Prefix>
  <Contents>
    <Key>mosaic/2026/09/27/mosaic_2026-09-27T00-10-00.jpg</Key>
    <LastModified>2026-09-27T00:12:31.000Z</LastModified>
    <Size>88112</Size>
  </Contents>
  <Contents>
    <Key>mosaic/2026/09/27/mosaic_2026-09-27T00-00-00.jpg</Key>
    <LastModified>2026-09-27T00:02:31.000Z</LastModified>
    <Size>87904</Size>
  </Contents>
</ListBucketResult>`;

const LISTING_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>is-birdcast-observed-prod</Name>
  <Prefix>mosaic/2026/09/27/</Prefix>
</ListBucketResult>`;

const LISTING_YESTERDAY = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Contents>
    <Key>mosaic/2026/09/26/mosaic_2026-09-26T23-50-00.jpg</Key>
    <LastModified>2026-09-26T23:52:31.000Z</LastModified>
    <Size>90112</Size>
  </Contents>
</ListBucketResult>`;

function textResponse(text) {
  return {
    ok: true,
    headers: { get: () => null },
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

/** Mock fetchImpl keyed on the mosaic date prefix in the listing URL. */
function mockFetchImpl({ today = LISTING_TODAY, yesterday = LISTING_YESTERDAY, seen = [], fail = false } = {}) {
  return async (url, options) => {
    seen.push({ url, options });
    if (fail) return { ok: false, status: 503, body: { cancel: async () => {} } };
    if (String(url).includes('mosaic/2026/09/27/')) return textResponse(today);
    if (String(url).includes('mosaic/2026/09/26/')) return textResponse(yesterday);
    throw new Error(`unexpected url ${url}`);
  };
}

test('listingUrl builds the mosaic date prefix', () => {
  assert.equal(
    listingUrl(new Date(Date.UTC(2026, 8, 27, 12))),
    'https://is-birdcast-observed-prod.s3.us-east-1.amazonaws.com/?list-type=2&prefix=mosaic/2026/09/27/&max-keys=50',
  );
});

test('parseS3Listing extracts keys and timestamps', () => {
  const entries = parseS3Listing(LISTING_TODAY);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].key, 'mosaic/2026/09/27/mosaic_2026-09-27T00-10-00.jpg');
  assert.equal(entries[0].lastModified, '2026-09-27T00:12:31.000Z');
  assert.deepEqual(parseS3Listing(LISTING_EMPTY), []);
  assert.throws(() => parseS3Listing('<html>nope</html>'), /unexpected_listing/);
});

test('pickLatest chooses the newest LastModified and absolutizes the key', () => {
  const latest = pickLatest(parseS3Listing(LISTING_TODAY));
  assert.equal(latest.key, 'mosaic/2026/09/27/mosaic_2026-09-27T00-10-00.jpg');
  assert.equal(
    latest.url,
    'https://is-birdcast-observed-prod.s3.us-east-1.amazonaws.com/mosaic/2026/09/27/mosaic_2026-09-27T00-10-00.jpg',
  );
  assert.equal(pickLatest([]), null);
});

test('handler returns the newest mosaic from today', async () => {
  clearCaches();
  const seen = [];
  const provider = birdcastProxy({ fetchImpl: mockFetchImpl({ seen }), now: () => Date.parse('2026-09-27T21:07:00Z') });
  const calls = mount(provider);
  assert.equal(calls[0].route, '/api/birdcast');
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.date, '2026-09-27');
  assert.equal(doc.count, 2);
  assert.equal(doc.latest.key, 'mosaic/2026/09/27/mosaic_2026-09-27T00-10-00.jpg');
  assert.ok(doc.latest.url.endsWith('.jpg'));
  assert.ok(doc.attribution.includes('BirdCast'));
  assert.ok(seen.every((s) => s.options.redirect === 'follow'));
});

test('empty today falls back to yesterday', async () => {
  clearCaches();
  const provider = birdcastProxy({
    fetchImpl: mockFetchImpl({ today: LISTING_EMPTY }),
    now: () => Date.parse('2026-09-27T21:07:00Z'),
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.date, '2026-09-26');
  assert.equal(doc.latest.key, 'mosaic/2026/09/26/mosaic_2026-09-26T23-50-00.jpg');
});

test('no mosaics at all yields an honest 502', async () => {
  clearCaches();
  const provider = birdcastProxy({
    fetchImpl: mockFetchImpl({ today: LISTING_EMPTY, yesterday: LISTING_EMPTY }),
    now: () => Date.parse('2026-09-27T21:07:00Z'),
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 502);
  const doc = JSON.parse(res.body);
  assert.equal(doc.error, 'birdcast_unavailable');
  assert.ok(/no_mosaics/.test(doc.detail));
});

test('upstream failure yields an honest 502', async () => {
  clearCaches();
  const provider = birdcastProxy({ fetchImpl: mockFetchImpl({ fail: true }) });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, 'birdcast_unavailable');
});

test('handler rejects non-GET with 405', async () => {
  clearCaches();
  const calls = mount(birdcastProxy({ fetchImpl: mockFetchImpl() }));
  const res = fakeRes();
  await calls[0].handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});
