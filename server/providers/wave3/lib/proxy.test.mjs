/**
 * Wave 3 Track 2c — shared keyless-proxy tests (server/providers/wave3/lib/proxy.js).
 * Uses injected fetchImpl and a controllable clock; no network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createKeylessProxy, mapLimit } from './proxy.js';

function mockReqRes(url = '/') {
  // Note: the dev-server middleware strips the mounted route before calling
  // the handler, so req.url here is only the sub-path/query ('/', '?q=..').
  const req = { method: 'GET', url };
  const res = {
    status: null,
    headers: null,
    body: null,
    listeners: {},
    writeHead(s, h) { res.status = s; res.headers = h; },
    end(b) { res.body = b; },
    once(ev, fn) { res.listeners[ev] = fn; },
    removeListener() {},
  };
  return { req, res };
}

function makePlugin({ failTimes = 0, now } = {}) {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls <= failTimes) throw new Error('boom');
    return { text: async () => 'ok', headers: { get: () => null }, body: null };
  };
  const plugin = createKeylessProxy({
    name: 't',
    route: '/api/x',
    ttlMs: 60_000,
    staleMs: 600_000,
    fetchUpstream: async ({ fetchImpl: f }) => {
      const r = await f('http://example.invalid/');
      return { text: await r.text() };
    },
    describe: (p, { stale = false, reason = null } = {}) => ({ payload: p ?? null, stale, reason }),
    fetchImpl,
    now,
  });
  let handler;
  plugin.configureServer({ middlewares: { use: (route, h) => { handler = h; } } });
  const get = async (url) => {
    const { req, res } = mockReqRes(url);
    handler(req, res);
    await new Promise((r) => setImmediate(r, 5));
    return res;
  };
  return { get, calls: () => calls };
}

test('createKeylessProxy caches within TTL, singleflights concurrent waiters', async () => {
  let t = 1_000_000;
  const { get, calls } = makePlugin({ now: () => t });
  const r1 = await get();
  assert.equal(r1.status, 200);
  assert.equal(JSON.parse(r1.body).payload.text, 'ok');
  t += 1000; // still within TTL
  await get();
  assert.equal(calls(), 1);
  const [a, b, c] = await Promise.all([get(), get(), get()]);
  assert.equal(calls(), 1); // singleflight
  assert.ok(a.status === 200 && b.status === 200 && c.status === 200);
});

test('createKeylessProxy serves stale after TTL when upstream fails', async () => {
  let t = 1_000_000;
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new Error('down');
    return { text: async () => 'fresh', headers: { get: () => null }, body: null };
  };
  const plugin = createKeylessProxy({
    name: 's', route: '/api/s', ttlMs: 1000, staleMs: 60_000,
    fetchUpstream: async ({ fetchImpl: f }) => ({ v: await (await f('http://x/')).text() }),
    describe: (p, { stale = false, reason = null } = {}) => ({ p, stale, reason }),
    fetchImpl, now: () => t,
  });
  let handler;
  plugin.configureServer({ middlewares: { use: (r, h) => { handler = h; } } });
  const get = async () => {
    const { req, res } = mockReqRes();
    handler(req, res);
    await new Promise((r) => setImmediate(r, 5));
    return JSON.parse(res.body);
  };
  const first = await get();
  assert.equal(first.p.v, 'fresh');
  t += 5000; // past TTL, inside stale window
  fail = true;
  const second = await get();
  assert.equal(second.stale, true);
  assert.equal(second.p.v, 'fresh');
  assert.match(second.reason, /Upstream/);
});

test('createKeylessProxy enforces a post-failure retry cooldown', async () => {
  let t = 1_000_000;
  const { get, calls } = makePlugin({ failTimes: 99, now: () => t });
  await get(); // fails, no cache
  assert.equal(calls(), 1);
  await get(); // inside cooldown -> 503 without a new upstream call
  assert.equal(calls(), 1);
  t += 61_000; // past the 60s retry cooldown
  await get();
  assert.equal(calls(), 2);
});

test('createKeylessProxy returns 400 JSON on invalid sub-paths and 405 on POST', async () => {
  let t = 1_000_000;
  let handler;
  const plugin = createKeylessProxy({
    name: 'h', route: '/api/h', ttlMs: 60_000, staleMs: 60_000,
    fetchUpstream: async () => ({}),
    describe: () => ({}),
    fetchImpl: async () => { throw new Error('unreachable'); },
    now: () => t,
  });
  plugin.configureServer({ middlewares: { use: (route, h) => { handler = h; } } });
  const call = async (url, method = 'GET') => {
    const { req, res } = mockReqRes(url);
    req.method = method;
    handler(req, res);
    await new Promise((r) => setImmediate(r, 5));
    return res;
  };
  const r400 = await call('/bogus');
  assert.equal(r400.status, 400);
  assert.equal(JSON.parse(r400.body).error, 'invalid_h_query');
  const r405 = await call('/', 'POST');
  assert.equal(r405.status, 405);
});

test('mapLimit bounds concurrency', async () => {
  let inFlight = 0;
  let maxSeen = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    inFlight++;
    maxSeen = Math.max(maxSeen, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.ok(maxSeen <= 2, `max in flight ${maxSeen}`);
});
