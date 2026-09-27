/**
 * reentries provider tests — mount shape + a stubbed-fetch end-to-end run
 * through the handler proving TLE → decay-candidate normalization.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { reentriesProxy } from './reentries.js';

function checksum68(line68) {
  let sum = 0;
  for (const c of line68) {
    if (c >= '0' && c <= '9') sum += Number(c);
    else if (c === '-') sum += 1;
  }
  return String(sum % 10);
}
function line1({ ndot = ' .08000000' } = {}) {
  const body = '1 88888U 26001A   ' + '26' + '270.50000000' + ' ' + ndot.padStart(10, ' ') +
    ' ' + ' 00000-0' + ' ' + ' 12345-6' + ' 0' + ' ' + ' 999';
    ' ' + ' 00000-0' + ' ' + ' 12345-6' + ' 0' + ' ' + ' 999';
  if (body.length !== 68) throw new Error(`l1 ${body.length}`);
  return body + checksum68(body);
}
function line2({ mm = '16.30000000' } = {}) {
  const body = '2 88888' + ' ' + ' 51.6400' + ' ' + '208.9163' + ' ' + '0010000' +
    ' ' + ' 69.9862' + ' ' + ' 25.2906' + ' ' + mm.padStart(11, ' ') + '00001';
  if (body.length !== 68) throw new Error(`l2 ${body.length}`);
  return body + checksum68(body);
}
const DECAYING_TLE = `FALLING DEBRIS\n${line1()}\n${line2()}\n`;
const HEALTHY_TLE = `HEALTHY SAT\n${line1({ ndot: ' .00002174' })}\n${line2({ mm: '15.72125391' })}\n`;

function fakeReq(url, method = 'GET') {
  return { method, url, on: () => {}, removeListener: () => {}, headers: {} };
}
function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null, headers: {},
    writeHead(s, h) { res.statusCode = s; res.headers = h; },
    end(b) { chunks.push(b); res.body = chunks.join(''); },
  };
  return res;
}
async function callHandler(provider, url) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (r, h) => calls.push({ r, h }) } });
  const res = fakeRes();
  await calls[0].h(fakeReq(url), res);
  return res;
}

test('reentriesProxy mounts /api/reentries on both server shapes', () => {
  const provider = reentriesProxy();
  assert.equal(provider.name, 'reentries');
  const seen = [];
  const middlewares = { use: (route) => seen.push(route) };
  provider.configureServer({ middlewares });
  provider.configurePreviewServer({ middlewares });
  assert.deepEqual(seen, ['/api/reentries', '/api/reentries']);
});

test('reentriesProxy rejects non-GET with 405', async () => {
  const provider = reentriesProxy();
  const calls = [];
  provider.configureServer({ middlewares: { use: (r, h) => calls.push({ r, h }) } });
  const res = fakeRes();
  await calls[0].h(fakeReq('/api/reentries', 'POST'), res);
  assert.equal(res.statusCode, 405);
  assert.match(res.body, /method_not_allowed/);
});

test('handler returns decaying candidate, drops healthy orbit (stubbed fetch)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    headers: { get: () => null },
    body: null,
    text: async () => (String(url).includes('GROUP=analyst') ? DECAYING_TLE : HEALTHY_TLE),
  });
  try {
    const res = await callHandler(reentriesProxy(), '/api/reentries?limit=10');
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 1);
    const c = payload.candidates[0];
    assert.equal(c.noradId, '88888');
    assert.equal(c.name, 'FALLING DEBRIS');
    assert.ok(c.daysToDecay > 0 && c.daysToDecay < 120);
    assert.ok(c.perigeeKm > 150 && c.perigeeKm < 400);
    assert.ok(c.line1.startsWith('1 88888') && c.line2.startsWith('2 88888'));
    assert.equal(c.source, 'tle-decay-model');
    assert.match(payload.honesty, /PREDICTION MODEL/);
    assert.equal(payload.model, 'tle-drag-extrapolation');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler 502s when upstream fails and no cache exists', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, headers: { get: () => null } });
  try {
    const res = await callHandler(reentriesProxy(), '/api/reentries');
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /reentries_upstream_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
