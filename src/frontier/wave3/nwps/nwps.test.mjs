import assert from 'node:assert/strict';
import test from 'node:test';
import {
  meanTrend,
  orderRibbon,
  trendColor,
  trendLabel,
  formatFlowShort,
} from './model.js';
import {
  nwpsProxy,
  parseComids,
  parseReachNode,
  parseSeries,
} from '../../../../server/providers/wave3/nwps.js';

// — model.js —

test('trendColor: rising -> warm, falling -> teal, unknown -> gray', () => {
  assert.equal(trendColor(Number.NaN), '#8a93a6');
  const up = trendColor(80);
  const down = trendColor(-80);
  const flat = trendColor(0);
  assert.match(up, /^#[0-9a-f]{6}$/);
  assert.match(down, /^#[0-9a-f]{6}$/);
  assert.equal(flat, '#cbd5e1');
  // red channel dominates for strong rises, green/blue for falls
  assert.ok(parseInt(up.slice(1, 3), 16) > parseInt(down.slice(1, 3), 16));
});

test('trendLabel formats signed percent', () => {
  assert.equal(trendLabel(12.6), '+13% fcast');
  assert.equal(trendLabel(-4.2), '-4% fcast');
  assert.equal(trendLabel(Number.NaN), 'trend n/a');
});

test('formatFlowShort compacts large flows', () => {
  assert.equal(formatFlowShort(2_500_000), '2.50M');
  assert.equal(formatFlowShort(4500), '4.5k');
  assert.equal(formatFlowShort(42.345), '42.3');
});

test('orderRibbon sorts by peak flow desc; meanTrend averages finite trends', () => {
  const nodes = [
    { reachId: 'a', peakFlow: 10, trendPct: 5 },
    { reachId: 'b', peakFlow: 100, trendPct: -5 },
    { reachId: 'c', peakFlow: null, trendPct: Number.NaN },
  ];
  assert.deepEqual(orderRibbon(nodes).map((n) => n.reachId), ['b', 'a', 'c']);
  assert.equal(meanTrend(nodes), 0);
  assert.equal(meanTrend([{ trendPct: Number.NaN }]), null);
});

// — provider parsing —

test('parseComids validates the list', () => {
  assert.deepEqual(parseComids('101,202'), ['101', '202']);
  assert.deepEqual(parseComids('101,101'), ['101']);
  assert.throws(() => parseComids(''), /nwps_missing_comid/);
  assert.throws(() => parseComids('abc'), /nwps_bad_comid/);
  assert.throws(() => parseComids('1,2,3,4,5,6,7'), /nwps_bad_comid_count/);
});

test('parseSeries accepts the five NWM products only', () => {
  assert.equal(parseSeries('medium_range'), 'medium_range');
  assert.equal(parseSeries(null), 'short_range');
  assert.throws(() => parseSeries('bogus'), /nwps_bad_series/);
});

const REACH_FIXTURE = {
  reach: {
    reachId: '101',
    name: 'Neches River',
    latitude: 31.0869,
    longitude: -94.6405,
    streamflow: ['short_range'],
    route: {
      upstream: [{ reachId: '24599575', streamOrder: '3' }],
      downstream: [{ reachId: '1078719', streamOrder: '3' }],
    },
  },
  shortRange: {
    series: {
      referenceTime: '2026-09-26T23:00:00Z',
      units: 'ft3/s',
      data: [
        { validTime: '2026-09-27T00:00:00Z', flow: 100 },
        { validTime: '2026-09-27T06:00:00Z', flow: 120 },
        { validTime: '2026-09-27T12:00:00Z', flow: 150 },
      ],
    },
  },
};

test('parseReachNode extracts trend, peak, and neighbors', () => {
  const node = parseReachNode(REACH_FIXTURE, 'short_range');
  assert.equal(node.reachId, '101');
  assert.equal(node.name, 'Neches River');
  assert.ok(Math.abs(node.lat - 31.0869) < 1e-6);
  assert.equal(node.trendPct, 50); // (150-100)/100*100
  assert.equal(node.peakFlow, 150);
  assert.deepEqual(node.neighbors, ['24599575', '1078719']);
  assert.equal(node.series.length, 3);
});

test('parseReachNode tolerates a missing series', () => {
  const node = parseReachNode({ reach: { reachId: '9', latitude: 1, longitude: 2 } }, 'short_range');
  assert.equal(node.trendPct, null);
  assert.equal(node.series.length, 0);
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
function fakeFetchJson(docsByComid, fail = new Set()) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const m = url.match(/reaches\/(\d+)\//);
    const comid = m ? m[1] : null;
    if (fail.has(comid)) {
      return { ok: false, status: 500, headers: { get: () => null }, body: { cancel: async () => {} }, text: async () => '' };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { cancel: async () => {} },
      text: async () => JSON.stringify(docsByComid[comid] ?? docsByComid.default),
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
  return res;
}

test('nwpsProxy mounts /api/nwps on both server shapes', () => {
  const proxy = nwpsProxy();
  assert.equal(proxy.name, 'nwps');
  const seen = [];
  proxy.configureServer({ middlewares: { use: (r) => seen.push(r) } });
  proxy.configurePreviewServer({ middlewares: { use: (r) => seen.push(r) } });
  assert.deepEqual(seen, ['/api/nwps', '/api/nwps']);
});

test('nwpsProxy rejects POST and bad comids', async () => {
  const post = await callHandler(nwpsProxy(), '/api/nwps?comid=101', 'POST');
  assert.equal(post.statusCode, 405);
  const bad = await callHandler(nwpsProxy(), '/api/nwps?comid=nope');
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /nwps_bad_comid/);
  const missing = await callHandler(nwpsProxy(), '/api/nwps');
  assert.equal(missing.statusCode, 400);
});

test('nwpsProxy fans out to neighbors and survives a bad neighbor', async () => {
  const docs = {
    101: REACH_FIXTURE,
    24599575: { reach: { reachId: '24599575', latitude: 31.2, longitude: -94.7, route: {} }, shortRange: { series: { referenceTime: 't', units: 'ft3/s', data: [] } } },
    default: { reach: { reachId: 'x', latitude: 0, longitude: 0, route: {} }, shortRange: { series: null } },
  };
  const { fetchImpl, calls } = fakeFetchJson(docs, new Set(['1078719']));
  const proxy = nwpsProxy({ fetchImpl, now: () => 2_000_000 });
  const res = await callHandler(proxy, '/api/nwps?comid=101&series=short_range');
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.series, 'short_range');
  const ids = doc.reaches.map((r) => r.reachId).sort();
  assert.deepEqual(ids, ['101', '24599575'], 'root + one good neighbor; bad neighbor dropped');
  assert.ok(calls.some((u) => u.includes('/101/streamflow?series=short_range')));
  const again = await callHandler(proxy, '/api/nwps?comid=101&series=short_range');
  assert.equal(again.statusCode, 200);
  assert.equal(calls.length, 3, 'ribbon result cached (root + 2 neighbor attempts)');
});
