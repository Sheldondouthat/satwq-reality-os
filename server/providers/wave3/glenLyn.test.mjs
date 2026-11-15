import assert from 'node:assert/strict';
import test from 'node:test';
import { glenLynProxy, _glenLynInternals } from './glenLyn.js';

const { parseGlenLynPayload, buildGlenLynPayload, clearCaches } =
  _glenLynInternals;

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
  };
  return res;
}

function fakeReq(method = 'GET') {
  return {
    method,
    url: '/api/usgs-water-glen-lyn',
    on: () => {},
    removeListener: () => {},
    headers: {},
  };
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

test('glenLynProxy mounts /api/usgs-water-glen-lyn on both server shapes', () => {
  const routes = mount(glenLynProxy()).map((c) => c.route);
  assert.deepEqual(routes, [
    '/api/usgs-water-glen-lyn',
    '/api/usgs-water-glen-lyn',
  ]);
});

// Fixture in the live WDFN latest-continuous shape, pinned against the
// real fetch of 2026-11-15 (values: 1,390 ft^3/s, 2.94 ft @ 07:30Z,
// approval_status Provisional on both features).
const WDFN_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        monitoring_location_id: 'USGS-03176500',
        parameter_code: '00060',
        statistic_id: '00011',
        time: '2026-11-15T07:30:00+00:00',
        value: '1390',
        unit_of_measure: 'ft^3/s',
        approval_status: 'Provisional',
        last_modified: '2026-11-15T07:42:19.259173+00:00',
      },
      geometry: { type: 'Point', coordinates: [-80.8606347244665, 37.3728986089149] },
    },
    {
      type: 'Feature',
      properties: {
        monitoring_location_id: 'USGS-03176500',
        parameter_code: '00065',
        statistic_id: '00011',
        time: '2026-11-15T07:30:00+00:00',
        value: '2.94',
        unit_of_measure: 'ft',
        approval_status: 'Provisional',
        last_modified: '2026-11-15T07:42:23.602492+00:00',
      },
      geometry: { type: 'Point', coordinates: [-80.8606347244665, 37.3728986089149] },
    },
  ],
  numberReturned: 2,
};

test('parseGlenLynPayload maps the WDFN shape to both variables', () => {
  const parsed = parseGlenLynPayload(WDFN_FIXTURE);
  assert.equal(parsed.discharge.value, 1390);
  assert.equal(parsed.discharge.unit, 'ft^3/s');
  assert.equal(parsed.gageHeight.value, 2.94);
  assert.equal(parsed.gageHeight.unit, 'ft');
  assert.equal(parsed.gageHeight.approvalStatus, 'Provisional');
  assert.equal(parsed.gageHeight.time, '2026-11-15T07:30:00.000Z');
  assert.ok(Math.abs(parsed.lat - 37.3728986089149) < 1e-9);
  assert.ok(Math.abs(parsed.lon - -80.8606347244665) < 1e-9);
});

test('parseGlenLynPayload accepts raw text and tolerates a missing variable', () => {
  const onlyFlow = {
    type: 'FeatureCollection',
    features: [WDFN_FIXTURE.features[0]],
  };
  const parsed = parseGlenLynPayload(JSON.stringify(onlyFlow));
  assert.equal(parsed.discharge.value, 1390);
  assert.equal(parsed.gageHeight, null, 'absence of a feature is the no-data signal');
});

test('parseGlenLynPayload throws when neither variable is present', () => {
  assert.throws(
    () => parseGlenLynPayload({ type: 'FeatureCollection', features: [] }),
    /glenlyn_no_data/,
  );
});

test('buildGlenLynPayload: dataTime is the older variable time; fresh reading is not stale', () => {
  const parsed = parseGlenLynPayload(WDFN_FIXTURE);
  const nowMs = Date.parse('2026-11-15T07:42:30Z'); // 750 s after the reading
  const payload = buildGlenLynPayload(parsed, nowMs);
  assert.equal(payload.dataTime, '2026-11-15T07:30:00.000Z');
  assert.equal(payload.ageSeconds, 750);
  assert.equal(payload.stale, false);
  assert.equal(payload.maxAgeSeconds, 3600);
  assert.equal(payload.gageHeightFt, 2.94);
  assert.equal(payload.dischargeCfs, 1390);
  assert.equal(payload.approvalStatus, 'Provisional');
  assert.deepEqual(payload.thresholds, { cautionFt: 13, floodStageFt: 15 });
});

test('buildGlenLynPayload: the D-1 ghost — a 22 h old reading under a fresh generatedAt reads STALE', () => {
  const parsed = parseGlenLynPayload(WDFN_FIXTURE);
  const nowMs = Date.parse('2026-11-16T05:30:00Z'); // 22 h after the reading
  const payload = buildGlenLynPayload(parsed, nowMs);
  assert.equal(payload.generatedAt, '2026-11-16T05:30:00.000Z', 'generatedAt is fresh');
  assert.equal(payload.ageSeconds, 22 * 3600, 'age is computed from dataTime, not generatedAt');
  assert.equal(payload.stale, true);
});

test('handler rejects non-GET with 405', async () => {
  clearCaches();
  const [{ handler }] = mount(glenLynProxy());
  const res = fakeRes();
  await handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});
