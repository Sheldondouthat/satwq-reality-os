import assert from 'node:assert/strict';
import test from 'node:test';
import {
  anomalyColor,
  basePixelSize,
  formatFlow,
  gaugeLabel,
  magnitudeClass,
  pulsePeriodMs,
} from './model.js';
import {
  anomalyPeriod,
  nwisGaugesProxy,
  parseBbox,
  parseWdfnPayload,
  quantizeBbox,
  trailingZ,
} from '../../../../server/providers/wave3/nwisGauges.js';

// — model.js —

test('anomalyColor maps z extremes to the diverging stops', () => {
  assert.equal(anomalyColor(3), '#ef4444');
  assert.equal(anomalyColor(-3), '#2563eb');
  assert.equal(anomalyColor(0), '#cbd5e1');
  assert.equal(anomalyColor(Number.NaN), '#8a93a6');
});

test('anomalyColor clamps beyond +-3', () => {
  assert.equal(anomalyColor(99), '#ef4444');
  assert.equal(anomalyColor(-99), '#2563eb');
});

test('magnitudeClass is log10 floored and bounded', () => {
  assert.equal(magnitudeClass(0.5), 0); // tiny but positive flow -> smallest class
  assert.equal(magnitudeClass(0), -1);
  assert.equal(magnitudeClass(-3), -1);
  assert.equal(magnitudeClass(5), 0);
  assert.equal(magnitudeClass(50000), 4);
  assert.equal(magnitudeClass(2_000_000), 6);
  assert.equal(magnitudeClass(2_000_000_000), 6);
});

test('pulsePeriodMs speeds up with |z|', () => {
  assert.equal(pulsePeriodMs(0), 2400);
  assert.equal(pulsePeriodMs(3), 800);
  assert.equal(pulsePeriodMs(-3), 800);
  assert.ok(pulsePeriodMs(1.5) < 2400 && pulsePeriodMs(1.5) > 800);
});

test('formatFlow uses compact units', () => {
  assert.equal(formatFlow(1_500_000), '1.50M cfs');
  assert.equal(formatFlow(500), '500 cfs');
  assert.equal(formatFlow(12.345), '12.3 cfs');
  assert.equal(formatFlow(Number.NaN), '—');
});

test('gaugeLabel includes name, flow and z when available', () => {
  const label = gaugeLabel({ name: 'Test River', flowCfs: 12000, flowZ: 2.345, flowN: 90 });
  assert.match(label, /Test River/);
  assert.match(label, /12.0k cfs/);
  assert.match(label, /z=\+2.3/);
});

test('basePixelSize grows with magnitude', () => {
  assert.ok(basePixelSize({ flowCfs: 1_000_000 }) > basePixelSize({ flowCfs: 10 }));
  assert.equal(basePixelSize({ flowCfs: Number.NaN }), 5);
});

// — provider parsing —

test('parseBbox accepts a valid bbox', () => {
  assert.deepEqual(parseBbox('-87.5,33,-86.5,34'), {
    minLon: -87.5, minLat: 33, maxLon: -86.5, maxLat: 34,
  });
});

test('parseBbox rejects garbage, inverted, and huge bboxes', () => {
  for (const bad of ['abc', '1,2,3', '-87.5,33,-88,34', '-200,24,-66,50', '-180,-90,180,90']) {
    assert.throws(() => parseBbox(bad), /nwis_/, `should reject ${bad}`);
  }
});

test('anomalyPeriod adapts the history window to bbox area', () => {
  assert.equal(anomalyPeriod({ minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }), 'P2D');
  assert.equal(anomalyPeriod({ minLon: 0, minLat: 0, maxLon: 2, maxLat: 2 }), 'P1D');
  assert.equal(anomalyPeriod({ minLon: -125, minLat: 24, maxLon: -66, maxLat: 50 }), null);
});

test('quantizeBbox snaps to half degrees', () => {
  assert.equal(quantizeBbox({ minLon: -87.51, minLat: 33.24, maxLon: -86.49, maxLat: 34.1 }), '-87.5,33,-86.5,34');
});

test('trailingZ scores the last value against its window', () => {
  const { z, n } = trailingZ([100, 102, 98, 101, 200]);
  assert.ok(z > 1.9, `expected strong positive z, got ${z}`);
  assert.equal(n, 5);
  assert.equal(trailingZ([5, 5, 5, 5]).z, 0);
  assert.equal(trailingZ([1, 2]).z, 0); // too few values
  assert.equal(trailingZ([-999999, -999999]).n, 0); // sentinel skipped
});

// WDFN GeoJSON form of the pre-port WaterML fixture (WDFN migration
// 2026-11-15): same gauge, same values, same instants (00:00-05:00 =
// 05:00Z). The dry gauge's no-data sentinel is spelled value:null by
// WDFN — and the name join is a fetch-path concern, so parser-level
// gauges carry their site number as the name.
function wdfnFixtureFeature(siteId, lat, lon, code, value, time) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      time_series_id: `ts-${siteId}-${code}`,
      monitoring_location_id: `USGS-${siteId}`,
      parameter_code: code,
      statistic_id: '00011',
      time,
      value: value == null ? null : String(value),
      unit_of_measure: code === '00060' ? 'ft^3/s' : 'ft',
      approval_status: 'Provisional',
      qualifier: null,
      last_modified: time,
    },
  };
}

const WDFN_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    wdfnFixtureFeature('02441500', 33.66565755, -86.592209, '00060', 9800, '2026-09-26T05:00:00+00:00'),
    wdfnFixtureFeature('02441500', 33.66565755, -86.592209, '00060', 10100, '2026-09-26T11:00:00+00:00'),
    wdfnFixtureFeature('02441500', 33.66565755, -86.592209, '00060', 9900, '2026-09-26T17:00:00+00:00'),
    wdfnFixtureFeature('02441500', 33.66565755, -86.592209, '00060', 15200, '2026-09-26T23:00:00+00:00'),
    wdfnFixtureFeature('02441500', 33.66565755, -86.592209, '00065', 12.4, '2026-09-26T23:00:00+00:00'),
    // dry gauge: only a no-data (value:null) feature -> skipped entirely
    wdfnFixtureFeature('99999999', 33.1, -86.1, '00060', null, '2026-09-26T23:00:00+00:00'),
  ],
};

test('parseWdfnPayload merges flow+height per site and skips dry gauges', () => {
  const gauges = parseWdfnPayload(WDFN_FIXTURE.features);
  assert.equal(gauges.length, 1);
  const g = gauges[0];
  assert.equal(g.id, '02441500');
  assert.equal(g.flowCfs, 15200);
  assert.equal(g.heightFt, 12.4);
  assert.ok(g.flowZ > 1, `spike should z-score high, got ${g.flowZ}`);
  assert.equal(g.flowN, 4);
  assert.ok(Math.abs(g.lat - 33.6656) < 0.001);
});

// — provider HTTP behavior —

function fakeReq(url, method = 'GET') {
  return { method, url, headers: {}, on: () => {}, removeListener: () => {} };
}
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
function fakeFetchJson(doc, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok,
      status,
      headers: { get: () => null },
      body: { cancel: async () => {} },
      text: async () => JSON.stringify(doc),
    };
  };
  return { fetchImpl, calls };
}
async function callHandler(proxy, url, method = 'GET') {
  const seen = [];
  proxy.configureServer({ middlewares: { use: (route, handler) => seen.push({ route, handler }) } });
  const req = fakeReq(url, method);
  const res = fakeRes();
  await seen[0].handler(req, res);
  return { res, route: seen[0].route };
}

test('nwisGaugesProxy mounts /api/nwis-gauges (+ /api/rivers alias) on both server shapes', () => {
  const proxy = nwisGaugesProxy();
  assert.equal(proxy.name, 'nwis-gauges');
  const seen = [];
  proxy.configureServer({ middlewares: { use: (r) => seen.push(r) } });
  proxy.configurePreviewServer({ middlewares: { use: (r) => seen.push(r) } });
  assert.deepEqual(seen, [
    '/api/nwis-gauges', '/api/rivers',
    '/api/nwis-gauges', '/api/rivers',
  ]);
});

test('nwisGaugesProxy rejects POST with 405', async () => {
  const { res } = await callHandler(nwisGaugesProxy(), '/api/nwis-gauges', 'POST');
  assert.equal(res.statusCode, 405);
});

test('nwisGaugesProxy rejects a bad bbox with 400', async () => {
  const { res } = await callHandler(nwisGaugesProxy(), '/api/nwis-gauges?bbox=nope');
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /nwis_bad_bbox/);
});

test('nwisGaugesProxy serves parsed gauges and caches the second call', async () => {
  const { fetchImpl, calls } = fakeFetchJson(WDFN_FIXTURE);
  const proxy = nwisGaugesProxy({ fetchImpl, now: () => 1_000_000 });
  const url = '/api/nwis-gauges?bbox=-87.5,33,-86.5,34';
  const first = await callHandler(proxy, url);
  assert.equal(first.res.statusCode, 200);
  const doc = JSON.parse(first.res.body);
  assert.equal(doc.count, 1);
  assert.equal(doc.gauges[0].id, '02441500');
  assert.equal(doc.anomalyBasis, 'trailing P2D z-score per gauge');
  assert.match(calls[0], /api\.waterdata\.usgs\.gov\/ogcapi\/v1\/collections\/continuous\/items/);
  assert.match(calls[0], /parameter_code=00060%2C00065/);
  const callsAfterFirst = calls.length; // data page(s) + the monitoring-locations name join
  const second = await callHandler(proxy, url);
  assert.equal(second.res.statusCode, 200);
  assert.equal(calls.length, callsAfterFirst, 'second identical request must hit the cache');
});
