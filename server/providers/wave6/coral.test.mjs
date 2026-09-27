import assert from 'node:assert/strict';
import test from 'node:test';
import { coralProxy, _coralInternals } from './coral.js';

const { ANIMATIONS, buildManifest, clearCaches } = _coralInternals;

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
  return { method, url: '/api/coral' };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('manifest carries all eight CRW regions with the GIF URL pattern', () => {
  clearCaches();
  const m = buildManifest();
  assert.equal(m.count, 8);
  assert.deepEqual(
    m.animations.map((a) => a.region).sort(),
    ['45ns', 'coraltriangle', 'crb', 'east', 'fl', 'gbr', 'hi', 'indian'],
  );
  const ids = new Set();
  for (const a of m.animations) {
    assert.ok(a.id && !ids.has(a.id), `duplicate id ${a.id}`);
    ids.add(a.id);
    assert.equal(
      a.url,
      `https://coralreefwatch.noaa.gov/data_current/5km/v3.1_op/animation/gif/sst_animation_30day_${a.region}_930x580.gif`,
    );
    assert.equal(a.format, 'animated GIF 930×580');
    assert.equal(a.attribution, 'NOAA Coral Reef Watch');
    assert.equal(a.probe, 'vm-206');
  }
  assert.ok(m.attribution.includes('Coral Reef Watch'));
  assert.ok(m.probeNote.includes('vm-206'));
});

test('handler mounts /api/coral and rejects non-GET', async () => {
  clearCaches();
  const calls = mount(coralProxy());
  assert.equal(calls[0].route, '/api/coral');
  const res = fakeRes();
  await calls[0].handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});

test('handler returns the full manifest on GET', async () => {
  clearCaches();
  const calls = mount(coralProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.count, 8);
  assert.ok(Array.isArray(doc.animations) && doc.animations.length === 8);
  assert.ok(Date.parse(doc.generatedAt) > 0);
});
