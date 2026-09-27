import assert from 'node:assert/strict';
import test from 'node:test';
import { auroraCamsProxy, _auroraCamsInternals } from './auroraCams.js';

const { CAMS, buildManifest, clearCaches } = _auroraCamsInternals;

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
  return { method, url: '/api/aurora-cams' };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('manifest carries the four catalogued cams with coordinates', () => {
  clearCaches();
  const m = buildManifest();
  assert.equal(m.count, 4);
  const byId = Object.fromEntries(m.cams.map((c) => [c.id, c]));
  assert.ok(byId['irf-kiruna'] && byId['uec-tromso'] && byId['tgo-skibotn'] && byId['auroramax-yellowknife']);
  for (const cam of m.cams) {
    assert.ok(Number.isFinite(cam.lat) && cam.lat > 55 && cam.lat < 75, cam.id);
    assert.ok(Number.isFinite(cam.lon) && cam.lon > -180 && cam.lon <= 180, cam.id);
    assert.ok(/^https:\/\//.test(cam.url), cam.id);
    // pinned latest/recent frame URLs (AuroraMAX uses "recent", the others "latest")
    assert.ok(cam.url.includes('latest') || cam.url.includes('Latest') || cam.url.includes('recent'), cam.id);
    assert.ok(['vm-200', 'vm-000'].includes(cam.probe), cam.id);
    assert.ok(cam.license && cam.attribution, cam.id);
  }
});

test('URL patterns match the catalogued shapes', () => {
  const byId = Object.fromEntries(CAMS.map((c) => [c.id, c]));
  assert.ok(byId['irf-kiruna'].url.endsWith('/alis/allsky/krn/latest_medium.jpeg'));
  assert.ok(byId['uec-tromso'].url.endsWith('/aurora_alert/latest.jpg'));
  assert.ok(byId['tgo-skibotn'].url.endsWith('/ASC/Latest_ASC01.png'));
  assert.ok(byId['auroramax-yellowknife'].url.endsWith('/recent/recent_480p.jpg'));
  // only AuroraMAX was reachable from the build VM
  assert.equal(byId['auroramax-yellowknife'].probe, 'vm-200');
  assert.equal(byId['irf-kiruna'].probe, 'vm-000');
});

test('handler mounts /api/aurora-cams and rejects non-GET', async () => {
  clearCaches();
  const calls = mount(auroraCamsProxy());
  assert.equal(calls[0].route, '/api/aurora-cams');
  const res = fakeRes();
  await calls[0].handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});

test('handler returns the full manifest on GET', async () => {
  clearCaches();
  const calls = mount(auroraCamsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.count, 4);
  assert.ok(Array.isArray(doc.cams) && doc.cams.length === 4);
  assert.ok(doc.probeNote.includes('VM-throttled'));
});
