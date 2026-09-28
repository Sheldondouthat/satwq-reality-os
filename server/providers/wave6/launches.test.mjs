import assert from 'node:assert/strict';
import test from 'node:test';
import { launchesProxy, _launchesInternals } from './launches.js';

const { parseLl2, parseRll, normalizeLaunch, normalizeName, dedupeLaunches, buildSnapshot, parseMonthYearNet } = _launchesInternals;

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

// Shapes follow each provider's documented JSON (both VM-throttled 2026-09-27).

const SAMPLE_LL2 = {
  count: 1,
  results: [
    {
      id: '2c2ba6e2-5a16-4c3c-9f4f-2a7f6e0b1234',
      name: 'Falcon 9 Block 5 | Starlink Group 10-30',
      net: '2026-09-28T00:00:00Z',
      window_start: '2026-09-28T00:00:00Z',
      window_end: '2026-09-28T02:30:00Z',
      status: { id: 1, name: 'Go for Launch' },
      rocket: { configuration: { name: 'Falcon 9', full_name: 'Falcon 9 Block 5' } },
      launch_service_provider: { name: 'SpaceX', type: 'Commercial' },
      pad: { name: 'Space Launch Complex 40', latitude: 28.5618571, longitude: -80.577366, location: { name: 'Cape Canaveral, FL, USA' } },
      mission: { name: 'Starlink Group 10-30', description: 'A batch of 24 satellites for the Starlink mega-constellation.', type: 'Communications' },
      url: 'https://ll.thespacedevs.com/2.2.0/launch/2c2ba6e2/',
    },
  ],
};

const SAMPLE_RLL = {
  valid_auth: false,
  count: 2,
  result: [
    {
      id: 4521,
      name: 'Falcon 9 Block 5 | Starlink Group 10-30',
      date_str: '2026-09-28 00:00 UTC',
      t0: '2026-09-28T00:00:00.000Z',
      vehicle: { name: 'Falcon 9' },
      provider: { name: 'SpaceX' },
      location: { name: 'Cape Canaveral' },
      missions: [{ name: 'Starlink 10-30', description: 'Starlink satellites to LEO.' }],
      tags: ['Go'],
    },
    {
      id: 4522,
      name: 'Electron | Owl The Way Up',
      date_str: 'NET Oct 2026',
      t0: null,
      vehicle: { name: 'Electron' },
      provider: { name: 'Rocket Lab' },
      location: { name: 'Mahia Peninsula' },
      missions: [],
      tags: ['TBD'],
    },
  ],
};

test('launchesProxy mounts /api/launches on both server shapes', () => {
  const routes = mount(launchesProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/launches', '/api/launches']);
});

test('normalizeName collapses punctuation and case', () => {
  assert.equal(normalizeName('Falcon 9 Block 5 | Starlink Group 10-30'), 'falcon 9 block 5 starlink group 10 30');
  assert.equal(normalizeName('  Falcon—9  '), 'falcon 9');
});

test('parseLl2 keeps vehicle/provider/pad/mission fields', () => {
  const launches = parseLl2(SAMPLE_LL2);
  assert.equal(launches.length, 1);
  const l = launches[0];
  assert.equal(l.id, 'll2:2c2ba6e2-5a16-4c3c-9f4f-2a7f6e0b1234');
  assert.equal(l.vehicle, 'Falcon 9 Block 5');
  assert.equal(l.provider, 'SpaceX');
  assert.equal(l.pad, 'Space Launch Complex 40');
  assert.equal(l.location, 'Cape Canaveral, FL, USA');
  assert.equal(l.status, 'Go for Launch');
  assert.equal(l.net, '2026-09-28T00:00:00.000Z');
  assert.equal(l.windowEnd, '2026-09-28T02:30:00.000Z');
  assert.match(l.mission, /Starlink/);
  assert.deepEqual(l.sources, ['ll2']);
  assert.equal(l.lat, 28.5618571);
  assert.equal(l.lon, -80.577366);
});

test('normalizeLaunch null-guards coordinates (never Number(null)===0)', () => {
  const l = normalizeLaunch({ id: 'a', name: 'x', lat: null, lon: undefined, source: 't' });
  assert.equal(l.lat, null);
  assert.equal(l.lon, null);
  const m = normalizeLaunch({ id: 'b', name: 'y', lat: '28.5', lon: 'not-a-number', source: 't' });
  assert.equal(m.lat, 28.5);
  assert.equal(m.lon, null);
});

test('parseMonthYearNet pins month-granularity NETs to UTC midnight (TZ-independent)', () => {
  assert.equal(parseMonthYearNet('NET Oct 2026'), '2026-10-01T00:00:00.000Z');
  assert.equal(parseMonthYearNet('Oct 2026'), '2026-10-01T00:00:00.000Z');
  assert.equal(parseMonthYearNet('jan 2027'), '2027-01-01T00:00:00.000Z');
  assert.equal(parseMonthYearNet('2026-09-28T00:00:00Z'), null); // full dates: not month-granularity
  assert.equal(parseMonthYearNet('October 1, 2026'), null);
  assert.equal(parseMonthYearNet(null), null);
});

test('dedupeLaunches carries coordinates across the merge', () => {
  const withCoords = normalizeLaunch({ id: 'll2:1', name: 'Falcon 9 | Starlink 10-30', net: '2026-09-28T00:00:00Z', lat: 28.56, lon: -80.57, source: 'll2' });
  const without = normalizeLaunch({ id: 'rll:2', name: 'Falcon 9 | Starlink 10-30', net: '2026-09-28T00:30:00Z', source: 'rll' });
  // survivor first without coords -> merged from the duplicate
  const merged = dedupeLaunches([without, withCoords]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].lat, 28.56);
  assert.equal(merged[0].lon, -80.57);
});

test('parseRll tolerates missing t0 (NET TBD) without a NET', () => {
  const launches = parseRll(SAMPLE_RLL);
  assert.equal(launches.length, 2);
  assert.equal(launches[0].id, 'rll:4521');
  assert.equal(launches[0].net, '2026-09-28T00:00:00.000Z');
  assert.equal(launches[1].net, '2026-10-01T00:00:00.000Z'); // 'NET Oct 2026' → month-granularity NET
  assert.equal(launches[1].name, 'Electron | Owl The Way Up');
});

test('normalizeLaunch drops records without id or name', () => {
  assert.equal(normalizeLaunch({ id: null, name: 'x', source: 'll2' }), null);
  assert.equal(normalizeLaunch({ id: 'a', name: '', source: 'll2' }), null);
});

test('dedupeLaunches merges the same flight across catalogs', () => {
  const all = [...parseLl2(SAMPLE_LL2), ...parseRll(SAMPLE_RLL)];
  assert.equal(all.length, 3);
  const merged = dedupeLaunches(all);
  assert.equal(merged.length, 2); // Starlink pair merged
  assert.equal(merged[0].name, 'Falcon 9 Block 5 | Starlink Group 10-30');
  assert.deepEqual([...merged[0].sources].sort(), ['ll2', 'rll']);
  assert.ok(merged[0].mission.length > 0); // kept the richer blurb
});

test('dedupeLaunches keeps distinct flights apart', () => {
  const a = normalizeLaunch({ id: 'll2:1', name: 'Falcon 9 | Starlink 10-30', net: '2026-09-28T00:00:00Z', source: 'll2' });
  const b = normalizeLaunch({ id: 'rll:2', name: 'Falcon 9 | Starlink 10-31', net: '2026-09-28T00:00:00Z', source: 'rll' });
  assert.equal(dedupeLaunches([a, b]).length, 2);
});

test('buildSnapshot sorts by NET and records per-source errors', () => {
  const mk = (key, ok, launches, error) => ({
    key, ok, launches, attribution: 'x', latencyMs: 5,
    count: launches.length, ...(ok ? {} : { error }),
  });
  const payload = buildSnapshot([
    mk('ll2', false, [], 'launches_ll2_upstream_429'),
    mk('rll', true, parseRll(SAMPLE_RLL)),
  ]);
  assert.equal(payload.count, 2);
  assert.equal(payload.sources.ll2.ok, false);
  assert.match(payload.sources.ll2.error, /429/);
  assert.equal(payload.merged, 0);
});

test('handler serves merged snapshot with mocked fetch', async () => {
  _launchesInternals.clearCaches();
  const calls = mount(launchesProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = url.includes('thespacedevs') ? SAMPLE_LL2 : SAMPLE_RLL;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/launches'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 2); // 1 merged Starlink + 1 Electron
    assert.equal(payload.merged, 1);
    assert.match(res.headers['Cache-Control'], /max-age=1800/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when both sources are down', async () => {
  _launchesInternals.clearCaches();
  const calls = mount(launchesProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/launches'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /launches_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(launchesProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/launches', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
