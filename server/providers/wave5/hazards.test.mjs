import assert from 'node:assert/strict';
import test from 'node:test';
import { hazardsProxy, _hazardsInternals } from './hazards.js';

const { trimHazardEvent, trimHazardsPayload, HAZARD_TYPES } = _hazardsInternals;

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

const SAMPLE_UPSTREAM = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      bbox: [-113.9, 21.3, -113.9, 21.3],
      geometry: { type: 'Point', coordinates: [-113.9, 21.3] },
      properties: {
        eventtype: 'TC',
        eventid: 1001325,
        episodeid: 28,
        name: 'Tropical Cyclone POLO-26',
        alertlevel: 'Orange',
        alertscore: 2,
        iscurrent: 'true',
        country: 'Mexico',
        iso3: 'MEX',
        fromdate: '2026-09-21T03:00:00',
        todate: '2026-09-27T15:00:00',
        severitydata: { severity: 287.0352, severitytext: 'Hurricane/Typhoon > 74 mph (maximum wind speed of 287 km/h)', severityunit: 'km/h' },
        url: {
          report: 'https://www.gdacs.org/report.aspx?eventid=1001325&episodeid=28&eventtype=TC',
          details: 'https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=TC&eventid=1001325',
        },
        source: 'NOAA',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [33.813, 0.938] },
      properties: {
        eventtype: 'FL',
        eventid: 1102402,
        episodeid: 14,
        name: 'Flood in Uganda',
        alertlevel: 'Red',
        alertscore: 3,
        iscurrent: 'false',
        country: 'Uganda',
        iso3: 'UGA',
        severitydata: {},
        url: {},
        source: '',
      },
    },
    { type: 'Feature', geometry: null, properties: {} }, // junk: dropped
  ],
};

test('hazardsProxy mounts /api/hazards on both server shapes', () => {
  const routes = mount(hazardsProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/hazards', '/api/hazards']);
});

test('trimHazardEvent keeps ids, severity text and URLs', () => {
  const e = trimHazardEvent(SAMPLE_UPSTREAM.features[0]);
  assert.equal(e.eventtype, 'TC');
  assert.equal(e.eventid, 1001325);
  assert.equal(e.alertlevel, 'Orange');
  assert.equal(e.iscurrent, true);
  assert.match(e.severityText, /287 km\/h/);
  assert.match(e.reportUrl, /gdacs\.org\/report\.aspx/);
  assert.equal(e.iso3, 'MEX');
});

test('trimHazardEvent maps unknown types to OTHER and normalizes flags', () => {
  const e = trimHazardEvent({
    geometry: { type: 'Point', coordinates: [0, 1] },
    properties: { eventtype: 'BOGUS', eventid: 9, alertlevel: 'Purple', iscurrent: 'false' },
  });
  assert.equal(e.eventtype, 'OTHER');
  assert.equal(e.alertlevel, 'Orange'); // unknown level → neutral Orange default
  assert.equal(e.iscurrent, false);
});

test('trimHazardsPayload sorts Red before Orange and counts by type', () => {
  const payload = trimHazardsPayload(SAMPLE_UPSTREAM);
  assert.equal(payload.count, 2); // junk dropped
  assert.equal(payload.events[0].alertlevel, 'Red');
  assert.equal(payload.currentCount, 1);
  assert.deepEqual(payload.byType, { TC: 1, FL: 1 });
  assert.ok(HAZARD_TYPES.includes('VO'));
});

test('handler serves trimmed snapshot with mocked fetch', async () => {
  const calls = mount(hazardsProxy());
  const realFetch = globalThis.fetch;
  const body = JSON.stringify(SAMPLE_UPSTREAM);
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/geo+json' } });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/hazards'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 2);
    assert.match(res.headers['Cache-Control'], /max-age=900/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when upstream is down', async () => {
  _hazardsInternals.clearCaches();
  const calls = mount(hazardsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/hazards'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /hazards_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(hazardsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/hazards', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
