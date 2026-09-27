import assert from 'node:assert/strict';
import test from 'node:test';
import { gracedbProxy, _gracedbInternals } from './gracedb.js';

const {
  gpsToIso,
  parseGraceCreated,
  isMockSuperevent,
  mapSuperevent,
  parseN,
  DISCLAIMER,
  clearCaches,
} = _gracedbInternals;

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

// ——— fixtures (shaped like the live 2026-09-27 probe) ———

const MDC_EVENT = {
  superevent_id: 'MS260927v',
  category: 'MDC',
  created: '2026-09-27 21:28:50 UTC',
  t_0: 1474578869.528163,
  far: 5.176954877338635e-16,
  labels: ['EM_READY', 'SIGNIF_LOCKED'],
  preferred_event_data: {
    pipeline: 'gstlal',
    group: 'CBC',
    instruments: 'H1,L1,V1',
  },
};

const REAL_EVENT = {
  superevent_id: 'S250626bn',
  category: 'CBC',
  created: '2025-06-26 10:00:00 UTC',
  t_0: 1435430400.0,
  far: 1e-12,
  labels: ['ADVOK'],
  preferred_event_data: {
    pipeline: 'pycbc',
    group: 'CBC',
    instruments: 'H1,L1',
  },
};

// ——— pure-function tests ———

test('gpsToIso converts GPS seconds to UTC (GPS epoch noted)', () => {
  // 1474578869.528163 GPS s → 2026-09-27T21:14:10.528Z (GraceDB's "created"
  // field read 21:28:50 — the ~14 min gap is the pipeline reporting latency).
  const iso = gpsToIso(1474578869.528163);
  assert.equal(iso, '2026-09-27T21:14:10.528Z');
  assert.throws(() => gpsToIso(NaN), /gracedb_bad_gps/);
});

test('parseGraceCreated parses the GraceDB created format', () => {
  assert.equal(
    parseGraceCreated('2026-09-27 21:28:50 UTC'),
    '2026-09-27T21:28:50Z',
  );
  assert.equal(parseGraceCreated('garbage'), null);
});

test('isMockSuperevent: MDC category is mock; S-named CBC is not', () => {
  const mdc = isMockSuperevent(MDC_EVENT);
  assert.equal(mdc.mock, true);
  assert.ok(mdc.reason.includes('MDC'));
  // id-pattern fallback: category missing but MS prefix present
  const fallback = isMockSuperevent({ superevent_id: 'MS260927u' });
  assert.equal(fallback.mock, true);
  assert.ok(fallback.reason.includes('MS'));
  const real = isMockSuperevent(REAL_EVENT);
  assert.equal(real.mock, false);
  assert.equal(real.reason, null);
});

test('mapSuperevent never presents a mock as real', () => {
  const mapped = mapSuperevent(MDC_EVENT);
  assert.equal(mapped.id, 'MS260927v');
  assert.equal(mapped.mock, true);
  assert.ok(mapped.mockReason);
  assert.ok(mapped.tIso.startsWith('2026-09-27T21:14'), mapped.tIso);
  assert.equal(mapped.created, '2026-09-27T21:28:50Z');
  assert.equal(mapped.preferredPipeline, 'gstlal');
  assert.equal(mapped.instruments, 'H1,L1,V1');
  assert.ok(mapped.url.includes('MS260927v'));
});

test('mapSuperevent throws 502 on a record without identity', () => {
  try {
    mapSuperevent({ category: 'CBC' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.status, 502);
  }
});

test('parseN clamps the requested count', () => {
  assert.equal(parseN(null), 20);
  assert.equal(parseN('5'), 5);
  assert.equal(parseN('0'), null);
  assert.equal(parseN('999'), null);
  assert.equal(parseN('abc'), null);
});

// ——— handler tests ———

function stubFetch(doc) {
  return async () => jsonResponse(doc);
}

const NOW = Date.parse('2026-09-27T21:40:00Z');

test('handler mounts /api/gracedb and labels every event honestly (redirect:follow)', async () => {
  clearCaches();
  const seen = [];
  const provider = gracedbProxy({
    fetchImpl: async (url, opts) => {
      seen.push([url, opts]);
      return jsonResponse({
        numRows: 6030,
        superevents: [MDC_EVENT, REAL_EVENT],
      });
    },
    now: () => NOW,
  });
  const calls = mount(provider);
  assert.equal(calls[0].route, '/api/gracedb');
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/gracedb' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen[0][1].redirect, 'follow');
  assert.ok(seen[0][0].includes('N=20'));
  const body = JSON.parse(res.body);
  assert.equal(body.total, 6030);
  assert.equal(body.mockCount, 1);
  assert.equal(body.realCount, 1);
  assert.equal(body.allRecentAreMock, false);
  assert.equal(body.disclaimer, DISCLAIMER);
  assert.ok(body.events[0].mock, 'the MDC event must be flagged mock');
  assert.equal(body.events[1].mock, false);
});

test('handler sets allRecentAreMock when every recent event is MDC', async () => {
  clearCaches();
  const provider = gracedbProxy({
    fetchImpl: stubFetch({ numRows: 6030, superevents: [MDC_EVENT] }),
    now: () => NOW,
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/gracedb?n=1' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.allRecentAreMock, true);
  assert.equal(body.returned, 1);
});

test('handler slices the 100-event page to the requested n (upstream ignores N)', async () => {
  clearCaches();
  const provider = gracedbProxy({
    fetchImpl: stubFetch({
      numRows: 6030,
      superevents: [MDC_EVENT, REAL_EVENT, MDC_EVENT, REAL_EVENT, MDC_EVENT],
    }),
    now: () => NOW,
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/gracedb?n=3' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.returned, 3);
  assert.equal(body.mockCount, 2);
  assert.equal(body.realCount, 1);
});

test('handler rejects out-of-range n with 400', async () => {
  clearCaches();
  const provider = gracedbProxy({
    fetchImpl: stubFetch({ numRows: 0, superevents: [] }),
    now: () => NOW,
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/gracedb?n=999' }, res);
  assert.equal(res.statusCode, 400);
});

test('handler 502s honestly when GraceDB is unreachable (no cache)', async () => {
  clearCaches();
  const abortError = () =>
    Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
  const provider = gracedbProxy({
    fetchImpl: async () => {
      throw abortError();
    },
    now: () => NOW,
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/gracedb' }, res);
  assert.equal(res.statusCode, 502);
});

test('handler 502s on a misshapen upstream document', async () => {
  clearCaches();
  const provider = gracedbProxy({
    fetchImpl: stubFetch({ nope: true }),
    now: () => NOW,
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/gracedb' }, res);
  assert.equal(res.statusCode, 502);
});

test('handler rejects non-GET with 405', async () => {
  clearCaches();
  const provider = gracedbProxy({
    fetchImpl: stubFetch({ numRows: 0, superevents: [] }),
    now: () => NOW,
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'POST', url: '/api/gracedb' }, res);
  assert.equal(res.statusCode, 405);
});
