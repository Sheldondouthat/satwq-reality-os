import assert from 'node:assert/strict';
import test from 'node:test';
import { solarImgProxy, _solarImgInternals } from './solarImg.js';

const { IMAGES, buildManifest, clearCaches } = _solarImgInternals;

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
  return { method, url: '/api/solar-img' };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('manifest carries all five instrument families', () => {
  clearCaches();
  const m = buildManifest();
  assert.equal(m.count, 21);
  assert.equal(m.images.length, 21);
  const byInst = (prefix) => m.images.filter((i) => i.id.startsWith(prefix));
  assert.equal(byInst('sdo-').length, 5);
  assert.equal(byInst('soho-').length, 5);
  assert.equal(byInst('stereo-').length, 3);
  assert.equal(byInst('suvi-').length, 6);
  assert.equal(byInst('proba2-').length, 2);
});

test('every entry is a pinned latest-* URL with probe metadata', () => {
  const m = buildManifest();
  const ids = new Set();
  for (const img of m.images) {
    assert.ok(img.id && !ids.has(img.id), `duplicate id ${img.id}`);
    ids.add(img.id);
    assert.ok(/^https:\/\//.test(img.url), img.id);
    // pinned "latest.*" URLs; the STEREO entry is the rolling rotation movie
    assert.ok(img.url.includes('latest') || img.url.includes('Latest') || img.url.includes('rotated'), img.id);
    assert.ok(['vm-200', 'catalog', 'vm-000'].includes(img.probe), img.id);
    assert.ok(img.attribution && img.license && img.cadence && img.format, img.id);
  }
  assert.ok(/SDO|NOAA/.test(m.attribution));
  assert.ok(m.probeNote.includes('vm-000'));
});

test('URL patterns match the catalogued shapes', () => {
  const byId = Object.fromEntries(IMAGES.map((i) => [i.id, i]));
  assert.ok(byId['sdo-aia-193'].url.endsWith('latest_1024_0193.jpg'));
  assert.ok(byId['soho-lasco-c2'].url.endsWith('c2/1024/latest.jpg'));
  assert.ok(byId['stereo-ahead-euvi-195'].url.includes('beacon/latest_256/ahead_euvi_195_latest.jpg'));
  assert.ok(byId['suvi-304'].url.endsWith('suvi/primary/304/latest.png'));
  assert.ok(byId['proba2-swap-synoptic'].url.endsWith('LatestSWAPsynopticMap.png'));
});

test('handler mounts /api/solar-img and rejects non-GET', async () => {
  clearCaches();
  const calls = mount(solarImgProxy());
  assert.equal(calls[0].route, '/api/solar-img');
  const res = fakeRes();
  await calls[0].handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});

test('handler returns the full manifest on GET', async () => {
  clearCaches();
  const calls = mount(solarImgProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.count, 21);
  assert.ok(Array.isArray(doc.images) && doc.images.length === 21);
  assert.ok(Date.parse(doc.generatedAt) > 0);
});
