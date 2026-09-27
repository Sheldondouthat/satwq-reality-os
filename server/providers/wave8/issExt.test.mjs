import assert from 'node:assert/strict';
import test from 'node:test';
import { issExtProxy, _issExtInternals } from './issExt.js';

const {
  ISS_STALE_AGE_MS,
  STALE_CREW_SIGNATURES,
  evaluateIssNow,
  evaluateAstros,
  clearCaches,
} = _issExtInternals;

// ——— harness ———

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(body) {
      chunks.push(body);
      res.body = chunks.join('');
    },
    once() {},
    removeListener() {},
  };
  return res;
}

function mount(provider) {
  const calls = [];
  provider.configureServer({
    middlewares: { use: (route, handler) => calls.push({ route, handler }) },
  });
  provider.configurePreviewServer({
    middlewares: { use: (route, handler) => calls.push({ route, handler }) },
  });
  return calls;
}

const jsonResponse = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(obj),
});

// ——— evaluator tests ———

test('evaluateIssNow accepts a fresh fix and reports its data age', () => {
  const nowMs = Date.parse('2026-09-27T21:30:00Z');
  const doc = {
    message: 'success',
    timestamp: Math.floor(nowMs / 1000) - 30,
    iss_position: { latitude: '-1.5180', longitude: '0.4329' },
  };
  const iss = evaluateIssNow(doc, nowMs);
  assert.equal(iss.ok, true);
  assert.equal(iss.latitude, -1.518);
  assert.equal(iss.longitude, 0.4329);
  assert.equal(iss.stale, false);
  assert.ok(
    iss.dataAgeMs >= 29000 && iss.dataAgeMs <= 32000,
    `age=${iss.dataAgeMs}`,
  );
  assert.equal(iss.staleReason, null);
});

test('evaluateIssNow flags a stale fix (older than 5 min)', () => {
  const nowMs = Date.parse('2026-09-27T21:30:00Z');
  const doc = {
    message: 'success',
    timestamp: Math.floor(nowMs / 1000) - 3600,
    iss_position: { latitude: '10.0', longitude: '20.0' },
  };
  const iss = evaluateIssNow(doc, nowMs);
  assert.equal(iss.stale, true);
  assert.ok(iss.staleReason.includes('3600s old'));
});

test('evaluateIssNow flags a future timestamp', () => {
  const nowMs = Date.parse('2026-09-27T21:30:00Z');
  const doc = {
    message: 'success',
    timestamp: Math.floor(nowMs / 1000) + 600,
    iss_position: { latitude: '10.0', longitude: '20.0' },
  };
  const iss = evaluateIssNow(doc, nowMs);
  assert.equal(iss.stale, true);
  assert.ok(iss.staleReason.includes('future'));
});

test('evaluateIssNow throws 502 on a non-success payload', () => {
  assert.throws(
    () => evaluateIssNow({ message: 'fail' }, Date.now()),
    /iss_ext_bad_iss_now/,
  );
  try {
    evaluateIssNow({ message: 'fail' }, Date.now());
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.status, 502);
  }
});

test('evaluateAstros flags the 2024-era roster as stale (observed 2026-09-27)', () => {
  const nowMs = Date.parse('2026-09-27T21:30:00Z');
  const doc = {
    message: 'success',
    number: 12,
    people: STALE_CREW_SIGNATURES.slice(0, 3).map((name) => ({
      name,
      craft: 'ISS',
    })),
  };
  const astros = evaluateAstros(doc, nowMs, nowMs + 1000);
  assert.equal(astros.ok, true);
  assert.equal(astros.upstreamTimestampProvided, false);
  assert.equal(astros.stale, true);
  assert.ok(astros.staleReason.includes('2024-era'));
  assert.equal(astros.dataAgeMs, 1000);
});

test('evaluateAstros does not flag an unknown roster', () => {
  const nowMs = Date.parse('2026-09-27T21:30:00Z');
  const doc = {
    message: 'success',
    number: 7,
    people: ['Anne Astronaut', 'Bob Cosmonaut'].map((name) => ({
      name,
      craft: 'ISS',
    })),
  };
  const astros = evaluateAstros(doc, nowMs, nowMs);
  assert.equal(astros.stale, false);
  assert.equal(astros.staleReason, null);
});

// ——— handler tests ———

function stubFetch(issDoc, astrosDoc) {
  return async (url) => {
    if (url.includes('iss-now')) return jsonResponse(issDoc);
    if (url.includes('astros')) return jsonResponse(astrosDoc);
    throw new Error(`unexpected url ${url}`);
  };
}

const NOW = Date.parse('2026-09-27T21:30:00Z');
const freshIss = {
  message: 'success',
  timestamp: Math.floor(NOW / 1000) - 10,
  iss_position: { latitude: '-1.5180', longitude: '0.4329' },
};
const staleAstros = {
  message: 'success',
  number: 12,
  people: STALE_CREW_SIGNATURES.map((name) => ({ name, craft: 'ISS' })),
};

test('handler mounts /api/iss-ext and labels the stale roster (redirect:follow)', async () => {
  clearCaches();
  const seen = [];
  const provider = issExtProxy({
    fetchImpl: async (url, opts) => {
      seen.push([url, opts]);
      return stubFetch(freshIss, staleAstros)(url);
    },
    now: () => NOW,
  });
  const calls = mount(provider);
  assert.equal(calls[0].route, '/api/iss-ext');
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/iss-ext' }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(seen.every(([, opts]) => opts.redirect === 'follow'));
  const body = JSON.parse(res.body);
  assert.equal(body.partial, true, 'stale roster makes the payload partial');
  assert.equal(body.iss.ok, true);
  assert.equal(body.iss.stale, false);
  assert.ok(body.iss.dataAgeMs >= 9000 && body.iss.dataAgeMs <= 12000);
  assert.equal(body.astros.ok, true);
  assert.equal(body.astros.stale, true);
  assert.equal(body.astros.upstreamTimestampProvided, false);
});

test('handler returns honest partial 200 when only one section succeeds', async () => {
  clearCaches();
  const provider = issExtProxy({
    fetchImpl: async (url) => {
      if (url.includes('iss-now')) return jsonResponse(freshIss);
      throw Object.assign(new Error('intermittent 000'), { status: 502 });
    },
    now: () => NOW,
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/iss-ext' }, res);
  assert.equal(res.statusCode, 200, 'one live section is enough for 200');
  const body = JSON.parse(res.body);
  assert.equal(body.iss.ok, true);
  assert.equal(body.astros.ok, false);
  assert.equal(body.astros.stale, true);
  assert.equal(body.partial, true);
});

test('handler 502s honestly when BOTH sections fail (no cache)', async () => {
  clearCaches();
  const abortError = () =>
    Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
  const provider = issExtProxy({
    fetchImpl: async () => {
      throw abortError();
    },
    now: () => NOW,
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/iss-ext' }, res);
  assert.equal(res.statusCode, 502);
});

test('handler rejects non-GET with 405', async () => {
  clearCaches();
  const provider = issExtProxy({
    fetchImpl: stubFetch(freshIss, staleAstros),
    now: () => NOW,
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'POST', url: '/api/iss-ext' }, res);
  assert.equal(res.statusCode, 405);
});
