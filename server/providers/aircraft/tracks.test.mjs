import assert from 'node:assert/strict';
import test from 'node:test';
import { trackBackfillProxies } from './tracks.js';

/** Minimal req/res doubles for the track-backfill middleware. */
function fakeReq(url) {
  return { method: 'GET', url, headers: {} };
}

function fakeRes() {
  const headers = {};
  const res = {
    statusCode: null,
    headers,
    setHeader(name, value) { headers[name] = value; },
    end(body) { res.body = body; },
  };
  return res;
}

function mountHandlers() {
  const provider = trackBackfillProxies();
  const handlers = {};
  provider.configureServer({ middlewares: { use: (route, h) => { handlers[route] = h; } } });
  return handlers;
}

test('adsblol trace: first request MISS, replay HIT with age header', async () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  const traceBody = '{"trace":[[1,2,3]]}';
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => traceBody,
    };
  };
  try {
    const handlers = mountHandlers();
    const url = '/api/adsblol/trace?hex=abc123';
    const res1 = fakeRes();
    await handlers['/api/adsblol/trace'](fakeReq(url), res1);
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.body, traceBody);
    assert.equal(res1.headers['X-Cache'], 'MISS');
    assert.equal(fetchCalls, 1);

    const res2 = fakeRes();
    await handlers['/api/adsblol/trace'](fakeReq(url), res2);
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.body, traceBody);
    assert.equal(res2.headers['X-Cache'], 'HIT');
    const ageMs = Number(res2.headers['X-Cache-Age-Ms']);
    assert.ok(Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 60_000);
    assert.equal(fetchCalls, 1, 'replay must not re-contact upstream');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('adsblol trace: bad hex rejected with 400', async () => {
  const handlers = mountHandlers();
  const res = fakeRes();
  await handlers['/api/adsblol/trace'](fakeReq('/api/adsblol/trace?hex=zzz'), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /hex must be/);
});
