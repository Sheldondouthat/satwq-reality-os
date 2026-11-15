import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nwisGaugesProxy,
  parseBbox,
  quantizeBbox,
  anomalyPeriod,
  trailingZ,
  parseWdfnPayload,
  bareSiteNumber,
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

test('FEATURED_SITES are the 20 live-verified gauges (2026-09-28)', () => {
  assert.equal(FEATURED_SITES.length, 20);
  assert.deepEqual(
    FEATURED_SITES.map((s) => s.id),
    ['01646500', '01463500', '07374000', '01578310', '08057410', '09380000', '14211720', '05586100', '06934500', '03294500', '14105700', '07263620', '08364000', '11447650', '07032000', '06329500', '07301500', '13037500', '03598000', '05587450'],
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

// — parseWdfnPayload (WDFN GeoJSON features; ported 2026-11-15) —

test('bareSiteNumber strips the agency prefix', () => {
  assert.equal(bareSiteNumber('USGS-03176500'), '03176500');
  assert.equal(bareSiteNumber('03176500'), '03176500');
  assert.equal(bareSiteNumber(null), '');
});

let tsCounter = 0;
function wdfnFeature(siteId, lat, lon, code, value, time, statistic = '00011') {
  return {
    type: 'Feature',
    id: `feature-${++tsCounter}`,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      time_series_id: `ts-${siteId}-${code}-${statistic}`,
      monitoring_location_id: `USGS-${siteId}`,
      parameter_code: code,
      statistic_id: statistic,
      time,
      value: String(value),
      unit_of_measure: code === '00060' ? 'ft^3/s' : 'ft',
      approval_status: 'Provisional',
      qualifier: null,
      last_modified: time,
    },
  };
}

function siteFeatures(siteId, lat, lon, code, values) {
  return values.map(([v, t]) => wdfnFeature(siteId, lat, lon, code, v, t));
}

// Same instants as the pre-port WaterML fixtures (19:00-19:45 -04:00 = 23:00-23:45Z).
const FLOW = [[1000, '2026-09-27T23:00:00+00:00'], [1100, '2026-09-27T23:15:00+00:00'],
  [1050, '2026-09-27T23:30:00+00:00'], [1200, '2026-09-27T23:45:00+00:00']];
const HEIGHT = [[10.1, '2026-09-27T23:00:00+00:00'], [10.2, '2026-09-27T23:15:00+00:00'],
  [10.15, '2026-09-27T23:30:00+00:00'], [10.3, '2026-09-27T23:45:00+00:00']];

test('parseWdfnPayload merges 00060+00065 into one gauge', () => {
  const features = [
    ...siteFeatures('01646500', 38.94977778, -77.12763889, '00060', FLOW),
    ...siteFeatures('01646500', 38.94977778, -77.12763889, '00065', HEIGHT),
  ];
  const gauges = parseWdfnPayload(features);
  assert.equal(gauges.length, 1);
  const g = gauges[0];
  assert.equal(g.id, '01646500');
  assert.equal(g.name, '01646500'); // unresolved until the monitoring-locations join
  assert.equal(g.flowCfs, 1200);
  assert.equal(g.heightFt, 10.3);
  assert.equal(g.flowN, 4);
  assert.ok(Number.isFinite(g.flowZ));
  assert.ok(Number.isFinite(g.timeMs));
});

test('parseWdfnPayload skips no-data sentinels and non-target codes', () => {
  const features = [
    wdfnFeature('00000001', 40, -77, '00060', -999999, '2026-09-27T23:00:00+00:00'),
    wdfnFeature('00000002', 40, -77, '72019', 5, '2026-09-27T23:00:00+00:00'),
  ];
  assert.equal(parseWdfnPayload(features).length, 0);
});

test('parseWdfnPayload prefers the instantaneous statistic (00011) series', () => {
  const features = [
    wdfnFeature('01646500', 38.95, -77.13, '00060', 999, '2026-09-27T23:45:00+00:00', '00003'),
    ...siteFeatures('01646500', 38.95, -77.13, '00060', FLOW),
  ];
  const gauges = parseWdfnPayload(features);
  assert.equal(gauges.length, 1);
  assert.equal(gauges[0].flowCfs, 1200);
  assert.equal(gauges[0].flowN, 4);
});

test('parseWdfnPayload treats value:null as no-data (never a fabricated 0)', () => {
  // Observed live 2026-11-15: gauge 03052500's discharge series is
  // all -999999 in IV and all value:null in WDFN continuous.
  const nullFeature = wdfnFeature('03052500', 39.0, -80.5, '00060', 0, '2026-09-27T23:45:00+00:00');
  nullFeature.properties.value = null;
  const heightFeature = wdfnFeature('03052500', 39.0, -80.5, '00065', 2.0, '2026-09-27T23:45:00+00:00');
  const gauges = parseWdfnPayload([nullFeature, heightFeature]);
  assert.equal(gauges.length, 1);
  assert.equal(gauges[0].flowCfs, null);
  assert.equal(gauges[0].flowN, 0);
  assert.equal(gauges[0].heightFt, 2.0);
});

test('parseWdfnPayload throws on a non-array payload', () => {
  assert.throws(() => parseWdfnPayload({ value: {} }), { message: /nwis_unexpected_shape/ });
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

function geojsonResponse(doc, status = 200) {
  return new Response(JSON.stringify(doc), {
    status,
    headers: { 'Content-Type': 'application/geo+json' },
  });
}

function mlDoc(numbers) {
  return {
    type: 'FeatureCollection',
    features: numbers.map((n) => ({
      type: 'Feature',
      id: `USGS-${n}`,
      geometry: { type: 'Point', coordinates: [-77.12763889, 38.94977778] },
      properties: {
        monitoring_location_number: n,
        monitoring_location_name: n === '01646500' ? 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA' : `STATION ${n}`,
      },
    })),
  };
}

/** Stub fetch: monitoring-locations URLs get the name doc, everything else the data doc. */
function stubFetch(dataDoc, seen) {
  return async (url) => {
    const text = String(url);
    seen?.push(text);
    if (text.includes('/monitoring-locations/')) {
      const numbers = new URL(text).searchParams.get('monitoring_location_number').split(',');
      return geojsonResponse(mlDoc(numbers));
    }
    return geojsonResponse(dataDoc);
  };
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

test('handler sites mode queries WDFN continuous with monitoring_location_number=', async () => {
  const seen = [];
  const dataDoc = {
    type: 'FeatureCollection',
    features: siteFeatures('01646500', 38.94977778, -77.12763889, '00060', FLOW),
  };
  const provider = nwisGaugesProxy({
    fetchImpl: stubFetch(dataDoc, seen),
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
  assert.equal(body.gauges[0].name, 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA');
  assert.ok(body.anomalyBasis.includes('P1D'));
  const url = seen[0];
  assert.ok(url.includes('/collections/continuous/items'), url);
  assert.ok(url.includes('monitoring_location_number=01646500%2C01463500') || url.includes('monitoring_location_number=01646500,01463500'), url);
  assert.ok(url.includes('datetime='), url);
  assert.ok(!url.includes('bbox='), url);
});

test('handler follows WDFN cursor pagination', async () => {
  const page1 = {
    type: 'FeatureCollection',
    features: siteFeatures('01646500', 38.95, -77.13, '00060', [[1200, '2026-09-27T23:45:00+00:00']]),
    links: [{ rel: 'next', href: 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-continuous/items?cursor=PAGE2' }],
  };
  const page2 = {
    type: 'FeatureCollection',
    features: siteFeatures('01463500', 40.22, -74.78, '00060', [[800, '2026-09-27T23:45:00+00:00']]),
    links: [],
  };
  const seen = [];
  const provider = nwisGaugesProxy({
    fetchImpl: async (url) => {
      const text = String(url);
      seen.push(text);
      if (text.includes('/monitoring-locations/')) {
        const numbers = new URL(text).searchParams.get('monitoring_location_number').split(',');
        return geojsonResponse(mlDoc(numbers));
      }
      return geojsonResponse(text.includes('cursor=PAGE2') ? page2 : page1);
    },
    now: () => 1_759_000_000_000,
  });
  const { handler } = mount(provider)[0];
  const res = fakeRes();
  await handler({ method: 'GET', url: '/api/nwis-gauges?bbox=-125,24,-66,50' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.count, 2);
  assert.deepEqual(body.gauges.map((g) => g.id).sort(), ['01463500', '01646500']);
  assert.ok(seen.some((u) => u.includes('cursor=PAGE2')), seen.join(' | '));
});

test('handler rejects malformed sites with 400', async () => {
  const provider = nwisGaugesProxy({ fetchImpl: stubFetch({ type: 'FeatureCollection', features: [] }) });
  const { handler } = mount(provider)[0];
  const res = fakeRes();
  await handler({ method: 'GET', url: '/api/nwis-gauges?sites=abc' }, res);
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /nwis_bad_site/);
});

test('handler bbox mode is unchanged', async () => {
  const seen = [];
  const provider = nwisGaugesProxy({
    fetchImpl: stubFetch({ type: 'FeatureCollection', features: [] }, seen),
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
  assert.ok(seen[0].includes('bbox=-78%2C38%2C-76%2C40') || seen[0].includes('bbox=-78,38,-76,40'), seen[0]);
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
