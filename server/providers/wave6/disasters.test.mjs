import assert from 'node:assert/strict';
import test from 'node:test';
import { disastersProxy, _disastersInternals } from './disasters.js';

const { trimDeclaration, trimDisastersPayload, clearCaches } = _disastersInternals;

const FEMA_ROW = {
  femaDeclarationString: 'FM-5672-AK',
  disasterNumber: 5672,
  state: 'AK',
  declarationType: 'FM',
  declarationDate: '2026-08-18T00:00:00.000Z',
  fyDeclared: 2026,
  incidentType: 'Fire',
  declarationTitle: 'MUKLUK FIRE',
  ihProgramDeclared: false,
  iaProgramDeclared: false,
  paProgramDeclared: true,
  hmProgramDeclared: false,
  incidentBeginDate: '2026-08-17T00:00:00.000Z',
  incidentEndDate: null,
  disasterCloseoutDate: null,
  tribalRequest: false,
  fipsStateCode: '02',
  fipsCountyCode: '240',
  placeCode: '99240',
  designatedArea: 'Southeast Fairbanks (Census Area)',
  region: 10,
  lastRefresh: '2026-08-20T20:50:08.994Z',
};

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
  return { method, url: '/api/disasters', headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('trimDeclaration normalizes a real FEMA row', () => {
  const d = trimDeclaration(FEMA_ROW);
  assert.equal(d.id, 'FM-5672-AK');
  assert.equal(d.declarationNumber, 5672);
  assert.equal(d.state, 'AK');
  assert.equal(d.declarationType, 'FM');
  assert.equal(d.declarationDate, '2026-08-18T00:00:00.000Z');
  assert.equal(d.incidentType, 'Fire');
  assert.equal(d.title, 'MUKLUK FIRE');
  assert.equal(d.designatedArea, 'Southeast Fairbanks (Census Area)');
  assert.equal(d.incidentBegin, '2026-08-17T00:00:00.000Z');
  assert.equal(d.incidentEnd, null);
  assert.equal(d.region, 10);
  assert.equal(d.tribalRequest, false);
  assert.deepEqual(d.programs, {
    individualHouseholds: false,
    individualAssistance: false,
    publicAssistance: true,
    hazardMitigation: false,
  });
  assert.equal(d.lastRefresh, '2026-08-20T20:50:08.994Z');
});

test('trimDeclaration rejects rows without an id', () => {
  assert.equal(trimDeclaration({}), null);
  assert.equal(trimDeclaration(null), null);
  assert.equal(trimDeclaration('junk'), null);
});

test('trimDisastersPayload trims, caps, and labels geo coverage honestly', () => {
  const upstream = {
    metadata: { count: 0 },
    DisasterDeclarationsSummaries: [FEMA_ROW, null, 'junk', {}],
  };
  const payload = trimDisastersPayload(upstream);
  assert.equal(payload.count, 1);
  assert.equal(payload.declarations[0].id, 'FM-5672-AK');
  assert.match(payload.geoCoverage, /no coordinates/);
  assert.match(payload.source, /FEMA/);
  assert.ok(Date.parse(payload.generatedAt));
});

test('trimDisastersPayload caps oversized feeds', () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ ...FEMA_ROW, femaDeclarationString: `DR-${i}-AK` }));
  const payload = trimDisastersPayload({ DisasterDeclarationsSummaries: rows });
  assert.equal(payload.count, 50);
});

test('disastersProxy mounts /api/disasters on dev and preview', () => {
  const calls = mount(disastersProxy());
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.route === '/api/disasters'));
});

test('disastersProxy handler rejects non-GET with 405', async () => {
  const [{ handler }] = mount(disastersProxy());
  const res = fakeRes();
  await handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
});

test('disastersProxy maps upstream abort to honest 502', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  const abortError = new Error('The operation was aborted.');
  abortError.name = 'AbortError';
  globalThis.fetch = () => Promise.reject(abortError);
  try {
    const [{ handler }] = mount(disastersProxy());
    const res = fakeRes();
    await handler(fakeReq(), res);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error, 'disasters_unavailable');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
