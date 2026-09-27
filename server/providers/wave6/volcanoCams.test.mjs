import assert from 'node:assert/strict';
import test from 'node:test';
import { volcanoCamsProxy, _volcanoCamsInternals } from './volcanoCams.js';

const { ASHCAM_CAMS, HVO_CAMS, parseAshcamListing, clearCaches } = _volcanoCamsInternals;

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
  return { method, url: '/api/volcano-cams' };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

// ——— fixtures ———

// imageApi rows carry imageId/md5/timestamp/imageUrl/suninfo (#106)
const ASHCAM_FIXTURE = [
  {
    imageId: 987654,
    md5: 'deadbeef',
    timestamp: '2026-09-27T21:02:00Z',
    imageUrl: 'https://avo.alaska.edu/ashcam-api/images//shishaldin_brpk/2026/269/shishaldin_brpk-20260927T210200Z.jpg',
    suninfo: { sunrise: '2026-09-27T16:40:00Z' },
  },
];

function jsonResponse(doc) {
  return {
    ok: true,
    headers: { get: () => null },
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(doc)).buffer,
  };
}

/** Mock fetchImpl: AVO imageApi succeeds except for failCodes (which 404). Records redirect option. */
function mockFetchImpl({ failCodes = new Set(), seen = [] } = {}) {
  return async (url, options) => {
    seen.push({ url, options });
    const m = /imageApi\/webcam\/([^/]+)\//.exec(String(url));
    if (!m) throw new Error(`unexpected url ${url}`);
    if (failCodes.has(m[1])) return { ok: false, status: 404, body: { cancel: async () => {} } };
    return jsonResponse(ASHCAM_FIXTURE);
  };
}

test('parseAshcamListing takes the newest row from either shape', () => {
  const p = parseAshcamListing(ASHCAM_FIXTURE);
  assert.equal(p.imageId, 987654);
  assert.equal(p.timestamp, '2026-09-27T21:02:00Z');
  assert.ok(p.imageUrl.includes('shishaldin_brpk-20260927T210200Z.jpg'));
  assert.deepEqual(parseAshcamListing({ images: ASHCAM_FIXTURE }), p);
  assert.equal(parseAshcamListing([]), null);
  assert.equal(parseAshcamListing({ images: [] }), null);
  assert.equal(parseAshcamListing([{ imageId: 1 }]), null); // no imageUrl
  assert.equal(parseAshcamListing(null), null);
});

test('ashcam codes follow the verified {volcano}_{site} format', () => {
  assert.ok(ASHCAM_CAMS.length >= 5);
  for (const c of ASHCAM_CAMS) {
    assert.match(c.code, /^[a-z_]+$/);
    assert.ok(c.volcano && c.site);
  }
  assert.ok(ASHCAM_CAMS.some((c) => c.code === 'shishaldin_brpk'));
});

test('handler returns AVO live frames plus the static HVO cam', async () => {
  clearCaches();
  const seen = [];
  const provider = volcanoCamsProxy({ fetchImpl: mockFetchImpl({ seen }) });
  const calls = mount(provider);
  assert.equal(calls[0].route, '/api/volcano-cams');
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.sources.avo.liveCount, ASHCAM_CAMS.length);
  assert.equal(doc.sources.avo.requested, ASHCAM_CAMS.length);
  assert.equal(doc.count, ASHCAM_CAMS.length + HVO_CAMS.length);
  const avo = doc.cams.find((c) => c.id === 'avo-shishaldin_brpk');
  assert.ok(avo.ok);
  assert.ok(avo.url.includes('shishaldin_brpk-20260927T210200Z.jpg'));
  const hvo = doc.cams.find((c) => c.id === 'hvo-k2cam');
  assert.ok(hvo.ok);
  assert.ok(hvo.url.endsWith('/observatories/hvo/cams/K2cam/images/M.jpg'));
  // every upstream fetch followed redirects (workerd rejects redirect:'error')
  assert.ok(seen.length >= ASHCAM_CAMS.length);
  assert.ok(seen.every((s) => s.options.redirect === 'follow'));
});

test('a failed AVO code degrades to a per-source error, HVO keeps the route alive', async () => {
  clearCaches();
  const provider = volcanoCamsProxy({ fetchImpl: mockFetchImpl({ failCodes: new Set(['cleveland_clcl']) }) });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.sources.avo.liveCount, ASHCAM_CAMS.length - 1);
  assert.ok(doc.sources.avo.errors.some((e) => e.includes('cleveland_clcl')));
  assert.ok(doc.cams.some((c) => c.id === 'hvo-k2cam' && c.ok));
});

test('handler rejects non-GET with 405', async () => {
  clearCaches();
  const calls = mount(volcanoCamsProxy({ fetchImpl: mockFetchImpl() }));
  const res = fakeRes();
  await calls[0].handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});
