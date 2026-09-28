import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nwisGaugesProxy,
  parseBbox,
  quantizeBbox,
  anomalyPeriod,
  trailingZ,
  parseNwisPayload,
  parseSites,
  FEATURED_SITES,
} from './nwisGauges.js';

// — parseSites —

test('parseSites accepts a validated, deduped list', () => {
  assert.deepEqual(parseSites('01646500,01463500'), ['01646500', '01463500']);
  assert.deepEqual(parseSites('01646500, 01646500,01463500'), ['01646500', '01463500']);
});

test('parseSites rejects empty, malformed, and oversized lists', () => {
  assert.throws(() => parseSites(''), { message: /nwis_sites_count/ });
  assert.throws(() => parseSites('01646500,abc'), { message: /nwis_bad_site/ });
  assert.throws(() => parseSites('01646;DROP'), { message: /nwis_bad_site/ });
  const tooMany = Array.from({ length: 21 }, (_, i) => `0164650${i}`).join(',');
  assert.throws(() => parseSites(tooMany), { message: /nwis_sites_count/ });
});

test('FEATURED_SITES are the 15 live-verified gauges (2026-09-28)', () => {
  assert.equal(FEATURED_SITES.length, 15);
  assert.deepEqual(
    FEATURED_SITES.map((s) => s.id),
    ['01646500', '01463500', '07374000', '01578310', '08057410', '09380000', '14211720', '05586100', '06934500', '03294500', '14105700', '07263620', '08364000', '11447650', '07032000'],
  );
  assert.ok(FEATURED_SITES.every((s) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon)));
  const potomac = FEATURED_SITES.find((s) => s.id === '01646500');
  assert.ok(potomac.name.includes('Potomac'));
});

// — trailingZ (math verified by hand) —

test('trailingZ computes the trailing-window z-score of the last value', () => {
  // values [1000,1100,1050,1200]: mean 1087.5, var 5468.75, sd ≈ 73.9497,
  // z = (1200 − 1087.5)/73.9497 ≈ 1.5212
  const { z, n, mean } = trailingZ([1000, 1100, 1050, 1200]);
  assert.equal(n, 4);
  assert.equal(mean, 1087.5);
  assert.ok(Math.abs(z - 1.5212) < 0.001, `z=${z}`);
});

test('trailingZ needs 3+ finite values', () => {
  assert.deepEqual(trailingZ([5, 7]), { z: 0, n: 2, mean: 5 });
  assert.equal(trailingZ([]).n, 0);
});

// — bbox helpers (unchanged behavior) —

test('parseBbox still validates bboxes', () => {
  assert.deepEqual(parseBbox('-125,24,-66,50'), { minLon: -125, minLat: 24, maxLon: -66, maxLat: 50 });
  assert.throws(() => parseBbox('a,b,c,d'), { message: /nwis_bad_bbox/ });
  assert.throws(() => parseBbox('-66,50,-125,24'), { message: /nwis_bbox_inverted/ });
});

test('anomalyPeriod sizes the window by area', () => {
  assert.equal(anomalyPeriod({ minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }), 'P2D');
  assert.equal(anomalyPeriod({ minLon: 0, minLat: 0, maxLon: 2, maxLat: 2 }), 'P1D');
  assert.equal(anomalyPeriod({ minLon: -125, minLat: 24, maxLon: -66, maxLat: 50 }), null);
});

test('quantizeBbox rounds to halves', () => {
  assert.equal(quantizeBbox({ minLon: -125.26, minLat: 24.24, maxLon: -66.1, maxLat: 50.49 }), '-125.5,24,-66,50.5');
});

// — parseNwisPayload —

function siteSeries(siteId, siteName, lat, lon, code, values) {
  return {
    sourceInfo: {
      siteCode: [{ value: siteId }],
      siteName,
      geoLocation: { geogLocation: { latitude: String(lat), longitude: String(lon) } },
    },
    variable: { variableCode: [{ value: code }] },
    values: [{
      value: values.map(([v, t]) => ({ value: String(v), dateTime: t })),
    }],
  };
}

const FLOW = [[1000, '2026-09-27T19:00:00.000-04:00'], [1100, '2026-09-27T19:15:00.000-04:00'],
  [1050, '2026-09-27T19:30:00.000-04:00'], [1200, '2026-09-27T19:45:00.000-04:00']];
const HEIGHT = [[10.1, '2026-09-27T19:00:00.000-04:00'], [10.2, '2026-09-27T19:15:00.000-04:00'],
  [10.15, '2026-09-27T19:30:00.000-04:00'], [10.3, '2026-09-27T19:45:00.000-04:00']];

test('parseNwisPayload merges 00060+00065 into one gauge', () => {
  const doc = {
    value: {
      timeSeries: [
        siteSeries('01646500', 'Potomac River near Wash, DC Little Falls pump sta', 38.94977778, -77.12763889, '00060', FLOW),
        siteSeries('01646500', 'Potomac River near Wash, DC Little Falls pump sta', 38.94977778, -77.12763889, '00065', HEIGHT),
      ],
    },
  };
  const gauges = parseNwisPayload(doc);
  assert.equal(gauges.length, 1);
  const g = gauges[0];
  assert.equal(g.id, '01646500');
  assert.equal(g.flowCfs, 1200);
  assert.equal(g.heightFt, 10.3);
  assert.equal(g.flowN, 4);
  assert.ok(Number.isFinite(g.flowZ));
  assert.ok(Number.isFinite(g.timeMs));
});

test('parseNwisPayload skips no-data sentinels and non-target codes', () => {
  const doc = {
    value: {
      timeSeries: [
        siteSeries('00000001', 'X', 40, -77, '00060', [[-999999, '2026-09-27T19:00:00.000-04:00']]),
        siteSeries('00000002', 'Y', 40, -77, '72019', [[5, '2026-09-27T19:00:00.000-04:00']]),
      ],
    },
  };
  assert.equal(parseNwisPayload(doc).length, 0);
});

// — handler with stubbed fetch —

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { chunks.push(body); res.body = chunks.join(''); },
    once() {}, removeListener() {},
  };
  return res;
}

function watermlResponse(doc, status = 200) {
  return new Response(JSON.stringify(doc), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('handler routes both /api/nwis-gauges and /api/rivers', () => {
  const calls = mount(nwisGaugesProxy());
  const routes = calls.map((c) => c.route);
  assert.ok(routes.includes('/api/nwis-gauges'));
  assert.ok(routes.includes('/api/rivers'));
});

test('handler sites mode queries the IV endpoint with sites=', async () => {
  const seen = [];
  const doc = {
    value: {
      timeSeries: [
        siteSeries('01646500', 'Potomac River near Wash, DC Little Falls pump sta', 38.94977778, -77.12763889, '00060', FLOW),
      ],
    },
  };
  const provider = nwisGaugesProxy({
    fetchImpl: async (url) => {
      seen.push(String(url));
      return watermlResponse(doc);
    },
    now: () => 1_759_000_000_000,
  });
  const { handler } = mount(provider)[0];
  const res = fakeRes();
  await handler({ method: 'GET', url: '/api/rivers?sites=01646500,01463500' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.count, 1);
  assert.deepEqual(body.sites, ['01646500', '01463500']);
  assert.equal(body.bbox, null);
  assert.equal(body.gauges[0].id, '01646500');
  assert.equal(body.gauges[0].flowCfs, 1200);
  assert.ok(body.anomalyBasis.includes('P1D'));
  const url = seen[0];
  assert.ok(url.includes('sites=01646500%2C01463500') || url.includes('sites=01646500,01463500'), url);
  assert.ok(!url.includes('bBox='), url);
});

test('handler rejects malformed sites with 400', async () => {
  const provider = nwisGaugesProxy({ fetchImpl: async () => watermlResponse({ value: { timeSeries: [] } }) });
  const { handler } = mount(provider)[0];
  const res = fakeRes();
  await handler({ method: 'GET', url: '/api/nwis-gauges?sites=abc' }, res);
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /nwis_bad_site/);
});

test('handler bbox mode is unchanged', async () => {
  const seen = [];
  const provider = nwisGaugesProxy({
    fetchImpl: async (url) => {
      seen.push(String(url));
      return watermlResponse({ value: { timeSeries: [] } });
    },
    now: () => 1_759_000_000_000,
  });
  const { handler } = mount(provider)[0];
  const res = fakeRes();
  await handler({ method: 'GET', url: '/api/nwis-gauges?bbox=-78,38,-76,40' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.bbox, '-78,38,-76,40');
  assert.equal(body.sites, null);
  assert.equal(body.count, 0);
  assert.ok(seen[0].includes('bBox=-78%2C38%2C-76%2C40') || seen[0].includes('bBox=-78,38,-76,40'), seen[0]);
});

test('handler degrades honestly on upstream failure', async () => {
  const provider = nwisGaugesProxy({ fetchImpl: async () => { throw new Error('down'); } });
  const { handler } = mount(provider)[0];
  const res = fakeRes();
  await handler({ method: 'GET', url: '/api/rivers?sites=01646500' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.unavailable, true);
  assert.equal(body.count, 0);
});
