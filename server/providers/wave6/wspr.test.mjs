import assert from 'node:assert/strict';
import test from 'node:test';
import { wsprProxy, _wsprInternals } from './wspr.js';

const { parseWsprRows, trimWsprPayload, clearCaches } = _wsprInternals;

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
  return { method, url: '/api/wspr-live', on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('wsprProxy mounts /api/wspr-live on both server shapes', () => {
  const routes = mount(wsprProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/wspr-live', '/api/wspr-live']);
});

// Fixture rows in the DESCRIBE-verified wspr.rx shape (2026-11-15),
// as returned by the pinned query in JSONEachRow format. Row 3 has a
// (0, 0) transmitter endpoint (unknown locator) and must be dropped.
const WSPR_FIXTURE = [
  '{"id":13651147969,"time":"2026-11-15 07:12:00","tx_sign":"DL2NL","tx_lat":51.479,"tx_lon":6.958,"rx_sign":"DL2NL/1","rx_lat":51.479,"rx_lon":6.958,"frequency":10140193,"snr":1,"drift":0,"power":23}',
  '{"id":13651146441,"time":"2026-11-15 07:10:00","tx_sign":"K1JT","tx_lat":41.73,"tx_lon":-72.71,"rx_sign":"W1AW","rx_lat":41.71,"rx_lon":-72.73,"frequency":14095600,"snr":-12,"drift":1,"power":37}',
  '{"id":13651130000,"time":"2026-11-15 07:08:00","tx_sign":"N0CALL","tx_lat":0,"tx_lon":0,"rx_sign":"W1AW","rx_lat":41.71,"rx_lon":-72.73,"frequency":7040000,"snr":-20,"drift":0,"power":30}',
].join('\n');

test('parseWsprRows maps the DESCRIBE-verified shape to the endpoint contract', () => {
  const spots = parseWsprRows(WSPR_FIXTURE);
  assert.equal(spots.length, 2, 'the (0,0)-endpoint row must be dropped');
  const first = spots[0];
  assert.equal(first.id, 13651147969, 'wspr.rx row id carried untouched');
  assert.equal(first.time, '2026-11-15T07:12:00.000Z', 'ClickHouse DateTime → ISO-8601 UTC');
  assert.equal(first.txCall, 'DL2NL');
  assert.equal(first.rxCall, 'DL2NL/1');
  assert.equal(first.freqMHz, 10.1402, 'frequency Hz normalized to MHz at the provider');
  assert.equal(first.snrDb, 1);
  assert.equal(first.drift, 0);
  assert.equal(first.powerDbm, 23);
  const second = spots[1];
  assert.equal(second.txCall, 'K1JT');
  assert.equal(second.freqMHz, 14.0956);
  assert.equal(second.snrDb, -12);
});

test('parseWsprRows tolerates empty and garbage input', () => {
  assert.deepEqual(parseWsprRows(''), []);
  assert.deepEqual(parseWsprRows(null), []);
  assert.deepEqual(parseWsprRows('\n\n'), []);
});

test('trimWsprPayload wraps spots with metadata and counts drops', () => {
  const payload = trimWsprPayload(WSPR_FIXTURE);
  assert.equal(payload.count, 2);
  assert.equal(payload.droppedNoCoords, 1, 'dropped rows are reported, never silent');
  assert.equal(payload.windowSec, 3600);
  assert.ok(Date.parse(payload.generatedAt) > 0);
  assert.equal(payload.spots.length, 2);
});

test('trimWsprPayload throws on a non-JSON upstream body (shape failure, not an empty hour)', () => {
  assert.throws(
    () => trimWsprPayload('Code: 60. DB::Exception: Table wspr.rx does not exist'),
    /wspr_upstream_bad_payload/,
  );
});

test('handler returns 405 for non-GET', async () => {
  clearCaches();
  const [{ handler }] = mount(wsprProxy());
  const res = fakeRes();
  await handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
});

test('handler returns 502 JSON when the upstream is down', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const [{ handler }] = mount(wsprProxy());
    const res = fakeRes();
    await handler(fakeReq('GET'), res);
    assert.equal(res.statusCode, 502);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'wspr_unavailable');
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});

test('handler serves parsed fixture on 200 and caches it', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(WSPR_FIXTURE, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  };
  try {
    const [{ handler }] = mount(wsprProxy());
    const res1 = fakeRes();
    await handler(fakeReq('GET'), res1);
    assert.equal(res1.statusCode, 200);
    const body1 = JSON.parse(res1.body);
    assert.equal(body1.count, 2);
    assert.equal(body1.droppedNoCoords, 1);
    const res2 = fakeRes();
    await handler(fakeReq('GET'), res2);
    assert.equal(fetchCalls, 1, 'second request must come from the TTL cache');
    assert.equal(JSON.parse(res2.body).count, 2);
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
