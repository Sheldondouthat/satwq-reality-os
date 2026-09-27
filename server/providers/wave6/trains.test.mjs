import assert from 'node:assert/strict';
import test from 'node:test';
import { trainsProxy, _trainsInternals } from './trains.js';

const { parseAmtraker, parseTransitDocs, normalizeTrain, normalizeTrainNumber, dedupeTrains, buildSnapshot } = _trainsInternals;

// Fixtures below follow the feeds' documented shapes, labeled as such —
// BOTH upstreams timed out from the build VM on 2026-09-27
// (curl 000 on api-v3.amtraker.com and asm-backend.transitdocs.com),
// so these are shape-faithful synthetic fixtures, not live captures.

// Amtraker v3 documented shape: object keyed by train number, values are
// arrays of event reports (newest last), fields per the public API docs.
const AMTRAKER_FIXTURE = {
  30: [
    {
      trainID: '30-2026-09-27', trainNum: 30, routName: 'Capitol Limited',
      lat: 39.12, lon: -76.77, heading: 'E', trainTimely: 'Y',
      eventCode: 'ENR', eventName: 'En Route', eventDT: '09/27/2026 16:30:00',
      origCode: 'WAS', destCode: 'CHI',
    },
    {
      trainID: '30-2026-09-27', trainNum: 30, routName: 'Capitol Limited',
      lat: 39.25, lon: -76.60, heading: 'E', trainTimely: 'N',
      eventCode: 'ENR', eventName: 'En Route', eventDT: '09/27/2026 16:45:00',
      origCode: 'WAS', destCode: 'CHI',
    },
  ],
  2150: [
    {
      trainID: '2150-2026-09-27', trainNum: 2150, routName: 'Acela',
      lat: 40.70, lon: -73.95, heading: 'NE', trainTimely: 'Y',
      eventCode: 'ARR', eventName: 'Arrived', eventDT: '09/27/2026 17:00:00',
      origCode: 'NYP', destCode: 'BOS',
    },
  ],
};

// TransitDocs /map: array of live trains (defensive parser — the parser
// accepts several plausible root shapes and field spellings).
const TRANSITDOCS_FIXTURE = [
  {
    train_number: '30', route_name: 'Capitol Limited', operator: 'Amtrak',
    lat: 39.30, lon: -76.55, heading: 'E', status: 'En Route',
    updated_at: '2026-09-27T16:50:00Z',
  },
  {
    train_number: 'VIA 1', route_name: 'Canadian', operator: 'VIA Rail',
    lat: 43.65, lon: -79.38, heading: 'W', status: 'En Route',
    updated_at: '2026-09-27T16:52:00Z',
  },
];

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

test('trainsProxy mounts /api/trains on both server shapes', () => {
  const routes = mount(trainsProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/trains', '/api/trains']);
});

test('normalizeTrainNumber extracts and normalizes digits', () => {
  assert.equal(normalizeTrainNumber(30), '30');
  assert.equal(normalizeTrainNumber('Acela 2150'), '2150');
  assert.equal(normalizeTrainNumber('0030'), '30');
  assert.equal(normalizeTrainNumber(null), null);
  assert.equal(normalizeTrainNumber('Canadian'), null);
});

test('normalizeTrain maps timely codes and parses eventDT', () => {
  const t = normalizeTrain({
    number: 30, name: 'Capitol Limited', lat: 39.25, lon: -76.60,
    heading: 'E', status: 'En Route', timely: 'N',
    updatedAt: '09/27/2026 16:45:00', source: 'amtraker',
  });
  assert.equal(t.number, '30');
  assert.equal(t.timely, false);
  assert.equal(t.updatedAt, '2026-09-27T16:45:00.000Z');
  assert.equal(t.lat, 39.25);
  assert.deepEqual(t.sources, ['amtraker']);
});

test('normalizeTrain accepts epoch seconds and rejects bad coords', () => {
  const ok = normalizeTrain({ number: '30', lat: 40, lon: -75, updatedAt: 1790515200, source: 'x' });
  assert.equal(ok.updatedAt, '2026-09-27T13:20:00.000Z');
  assert.equal(normalizeTrain({ number: '30', lat: 999, lon: -75, source: 'x' }), null);
  assert.equal(normalizeTrain({ number: null, lat: 40, lon: -75, source: 'x' }), null);
});

test('parseAmtraker takes the newest report per train', () => {
  const trains = parseAmtraker(AMTRAKER_FIXTURE);
  assert.equal(trains.length, 2);
  const t30 = trains.find((t) => t.number === '30');
  assert.equal(t30.name, 'Capitol Limited');
  assert.equal(t30.lat, 39.25); // newest report
  assert.equal(t30.timely, false); // newest report's 'N'
  assert.equal(t30.updatedAt, '2026-09-27T16:45:00.000Z');
  const acela = trains.find((t) => t.number === '2150');
  assert.equal(acela.name, 'Acela');
  assert.equal(acela.timely, true);
});

test('parseAmtraker tolerates an array-rooted feed', () => {
  const trains = parseAmtraker(AMTRAKER_FIXTURE[2150]);
  assert.equal(trains.length, 1);
  assert.equal(trains[0].number, '2150');
});

test('parseTransitDocs reads the defensive shape', () => {
  const trains = parseTransitDocs(TRANSITDOCS_FIXTURE);
  assert.equal(trains.length, 2);
  assert.equal(trains[0].number, '30');
  assert.equal(trains[0].updatedAt, '2026-09-27T16:50:00.000Z');
  assert.equal(trains[1].number, '1'); // "VIA 1" → digits "1"
});

test('parseTransitDocs accepts a .trains wrapper object', () => {
  const trains = parseTransitDocs({ trains: TRANSITDOCS_FIXTURE });
  assert.equal(trains.length, 2);
});

test('dedupeTrains merges by number, unioning sources, fresher position wins', () => {
  const merged = dedupeTrains([
    ...parseAmtraker(AMTRAKER_FIXTURE),
    ...parseTransitDocs(TRANSITDOCS_FIXTURE),
  ]);
  assert.equal(merged.length, 3); // 30, 2150, 1
  const t30 = merged.find((t) => t.number === '30');
  assert.deepEqual(t30.sources.sort(), ['amtraker', 'transitdocs']);
  // TransitDocs report is newer (16:50 > 16:45) → its position wins
  assert.equal(t30.lat, 39.3);
  assert.equal(t30.updatedAt, '2026-09-27T16:50:00.000Z');
  // Amtrak name kept (Amtraker listed first)
  assert.equal(t30.name, 'Capitol Limited');
});

test('handler serves merged snapshot with mocked fetch', async () => {
  _trainsInternals.clearCaches();
  const calls = mount(trainsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(
    JSON.stringify(String(url).includes('amtraker') ? AMTRAKER_FIXTURE : TRANSITDOCS_FIXTURE),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/trains'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 3);
    assert.equal(payload.sources.amtraker.ok, true);
    assert.equal(payload.sources.transitdocs.ok, true);
    assert.match(res.headers['Cache-Control'], /max-age=60/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when all upstreams are down', async () => {
  _trainsInternals.clearCaches();
  const calls = mount(trainsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/trains'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /trains_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(trainsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/trains', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
