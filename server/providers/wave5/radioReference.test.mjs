import assert from 'node:assert/strict';
import test from 'node:test';
import { radioReferenceProxy, _radioReferenceInternals } from './radioReference.js';

const { trimCallsign, parseAmsatTle, trimNumbersSearch } = _radioReferenceInternals;

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

function fakeReq(url, method = 'GET') {
  return { method, url, on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

const SAMPLE_CALLOOK = {
  status: 'VALID',
  type: 'CLUB',
  current: { callsign: 'W1AW', operClass: '' },
  previous: { callsign: '', operClass: '' },
  trustee: { callsign: 'NA2AA', name: 'Minster, David A' },
  name: 'ARRL HQ OPERATORS CLUB',
  address: { line1: '225 MAIN ST', line2: 'NEWINGTON, CT 06111' },
  location: { latitude: '41.714707', longitude: '-72.728411', gridsquare: 'FN31pr' },
  license: { expires: '08/18/2032' },
};

const SAMPLE_AMSAT = [
  'SB KEPS @ AMSAT  $ORB26270.1',
  '2Line Orbital Elements 26270.AMSAT',
  '',
  '0 ISS (ZARYA)',
  '1 25544U 98067A   26270.17419514  .00009528  00000-0  18291-3 0  9997',
  '2 25544  51.6315 155.3455 0007168 193.0560 167.0244 15.48664528587561',
  '0 AO-7',
  '1 07530U 74089B   26270.50000000  .00000000  00000-0  00000-0 0  9999',
  '2 07530 101.9000 200.0000 0010000 100.0000 260.0000 12.00000000123456',
  'not a tle line',
].join('\n');

const SAMPLE_NUMBERS = [
  { id: 1636, title: 'UVB-76 The Buzzer', url: 'https://www.numbers-stations.com/x', type: 'post', subtype: 'page' },
  'junk',
  null,
];

test('radioReferenceProxy mounts /api/radio-reference on both server shapes', () => {
  const routes = mount(radioReferenceProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/radio-reference', '/api/radio-reference']);
});

test('trimCallsign keeps callsign, coords, honesty-safe fields', () => {
  const t = trimCallsign(SAMPLE_CALLOOK);
  assert.equal(t.callsign, 'W1AW');
  assert.equal(t.name, 'ARRL HQ OPERATORS CLUB');
  assert.equal(t.lat, 41.714707);
  assert.equal(t.lon, -72.728411);
  assert.equal(t.gridsquare, 'FN31pr');
  assert.ok(t.source.includes('callook.info'));
});

test('trimCallsign tolerates missing location', () => {
  const t = trimCallsign({ status: 'VALID', current: { callsign: 'XX0XX' } });
  assert.equal(t.lat, null);
  assert.equal(t.address, '');
});

test('parseAmsatTle skips the preamble and pairs 3LE rows', () => {
  const rows = parseAmsatTle(SAMPLE_AMSAT);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'ISS (ZARYA)');
  assert.equal(rows[0].noradId, 25544);
  assert.ok(rows[0].line1.startsWith('1 25544'));
  assert.ok(rows[0].line2.startsWith('2 25544'));
  assert.equal(rows[1].noradId, 7530);
});

test('parseAmsatTle ignores incomplete triples', () => {
  assert.deepEqual(parseAmsatTle('0 LONELY\n1 12345U'), []);
  assert.deepEqual(parseAmsatTle(''), []);
});

test('trimNumbersSearch drops junk rows and trims', () => {
  const rows = trimNumbersSearch(SAMPLE_NUMBERS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'UVB-76 The Buzzer');
  assert.deepEqual(trimNumbersSearch(null), []);
});

test('handler serves ?call= with mocked fetch', async () => {
  const calls = mount(radioReferenceProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(SAMPLE_CALLOOK), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/radio-reference?call=w1aw'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.callsign, 'W1AW');
    assert.ok(payload.honesty.includes('not live'));
  } finally {
    globalThis.fetch = realFetch;
    _radioReferenceInternals.clearCaches();
  }
});

test('handler returns 404 for invalid callsign status', async () => {
  const calls = mount(radioReferenceProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'INVALID' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/radio-reference?call=ZZ9ZZ'), res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body, /callsign_not_found/);
  } finally {
    globalThis.fetch = realFetch;
    _radioReferenceInternals.clearCaches();
  }
});

test('handler rejects malformed callsign with 400', async () => {
  const calls = mount(radioReferenceProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/radio-reference?call=!!'), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /invalid_callsign/);
});

test('handler serves ?tle=1 parsed rows', async () => {
  const calls = mount(radioReferenceProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(SAMPLE_AMSAT, {
    status: 200, headers: { 'Content-Type': 'text/plain' },
  });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/radio-reference?tle=1'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 2);
    assert.ok(payload.honesty.includes('Complements /api/celestrak'));
  } finally {
    globalThis.fetch = realFetch;
    _radioReferenceInternals.clearCaches();
  }
});

test('handler serves ?search= with honesty label', async () => {
  const calls = mount(radioReferenceProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(SAMPLE_NUMBERS), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/radio-reference?search=UVB-76'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 1);
    assert.ok(payload.honesty.includes('NOT live telemetry'));
  } finally {
    globalThis.fetch = realFetch;
    _radioReferenceInternals.clearCaches();
  }
});

test('handler returns 400 usage when no dataset param', async () => {
  const calls = mount(radioReferenceProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/radio-reference'), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /usage/);
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(radioReferenceProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/radio-reference', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
