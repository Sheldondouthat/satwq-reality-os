import assert from 'node:assert/strict';
import test from 'node:test';
import {
  glowAlpha,
  glowPulseMs,
  glowRadii,
  kpColor,
  kpLabel,
} from './model.js';
import {
  kpToGScale,
  parseAlertsPayload,
  parseKpPayload,
  swpcProxy,
} from '../../../../server/providers/wave3/swpc.js';

// — model.js —

test('kpColor ramps green -> yellow -> red -> violet', () => {
  assert.equal(kpColor(0), '#3ddc84');
  assert.equal(kpColor(9), '#c83cdc');
  assert.equal(kpColor(5), '#ff9f43');
  assert.equal(kpColor(Number.NaN), '#8a93a6');
  assert.match(kpColor(2.5), /^#[0-9a-f]{6}$/);
});

test('glowRadii inflates with Kp and glowAlpha/glowPulseMs scale sanely', () => {
  const calm = glowRadii(1);
  const storm = glowRadii(8);
  assert.ok(storm.x > calm.x);
  assert.ok(calm.x > 6_371_000);
  assert.ok(glowAlpha(8) > glowAlpha(1));
  assert.ok(glowPulseMs(8) < glowPulseMs(1));
  assert.equal(glowPulseMs(0), 6000);
  assert.equal(glowPulseMs(9), 1500);
});

test('kpLabel includes the G-scale when storming', () => {
  assert.equal(kpLabel({ kp: 3, gScale: 'G0' }), 'Kp 3');
  assert.equal(kpLabel({ kp: 7, gScale: 'G3' }), 'Kp 7 G3');
  assert.equal(kpLabel({}), 'Kp n/a');
});

// — provider parsing —

test('kpToGScale follows the NOAA storm scale', () => {
  assert.equal(kpToGScale(0), 'G0');
  assert.equal(kpToGScale(4), 'G0');
  assert.equal(kpToGScale(5), 'G1');
  assert.equal(kpToGScale(6), 'G2');
  assert.equal(kpToGScale(7), 'G3');
  assert.equal(kpToGScale(8), 'G4');
  assert.equal(kpToGScale(9), 'G5');
  assert.equal(kpToGScale(Number.NaN), null);
});

const KP_FIXTURE = [
  { time_tag: '2026-09-27T05:46:00', kp_index: 2, estimated_kp: 2.0, kp: '2Z' },
  { time_tag: '2026-09-27T05:47:00', kp_index: 3, estimated_kp: 2.67, kp: '3M' },
  { time_tag: '2026-09-27T05:48:00', kp_index: 6, estimated_kp: 5.67, kp: '6M' },
];

test('parseKpPayload takes the latest feed entry', () => {
  const kp = parseKpPayload(KP_FIXTURE);
  assert.equal(kp.kp, 6);
  assert.equal(kp.estimatedKp, 5.67);
  assert.equal(kp.gScale, 'G2');
  assert.ok(Number.isFinite(kp.timeTagMs));
  assert.throws(() => parseKpPayload([]), /unexpected_shape/);
});

const ALERTS_FIXTURE = (now) => [
  {
    product_id: 'EF3A',
    issue_datetime: new Date(now - 3600_000).toISOString().replace('T', ' ').slice(0, 23),
    message:
      'Space Weather Message Code: ALTEF3\r\nSerial Number: 3746\r\n' +
      'CONTINUED ALERT: Electron 2MeV Integral Flux exceeded 1,000pfu',
  },
  {
    product_id: 'OLD',
    issue_datetime: new Date(now - 72 * 3600_000).toISOString().replace('T', ' ').slice(0, 23),
    message: 'Space Weather Message Code: WARKP5\r\nOld news',
  },
];

test('parseAlertsPayload keeps 48h alerts newest-first with codes', () => {
  const now = Date.parse('2026-09-27T06:00:00Z');
  const alerts = parseAlertsPayload(ALERTS_FIXTURE(now), now);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, 'ALTEF3');
  assert.match(alerts[0].headline, /CONTINUED ALERT/);
  assert.ok(alerts[0].headline.length <= 220);
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
function fakeFetch(kpDoc, alertsDoc, { alertsFail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('alerts.json') && alertsFail) {
      return { ok: false, status: 500, headers: { get: () => null }, body: { cancel: async () => {} }, text: async () => '' };
    }
    const doc = url.includes('alerts.json') ? alertsDoc : kpDoc;
    return {
      ok: true,
      status: 200,
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
  return res;
}

test('swpcProxy mounts /api/space-weather on both server shapes', () => {
  const proxy = swpcProxy();
  assert.equal(proxy.name, 'swpc');
  const seen = [];
  proxy.configureServer({ middlewares: { use: (r) => seen.push(r) } });
  proxy.configurePreviewServer({ middlewares: { use: (r) => seen.push(r) } });
  assert.deepEqual(seen, ['/api/space-weather', '/api/space-weather']);
});

test('swpcProxy rejects POST with 405', async () => {
  const res = await callHandler(swpcProxy(), '/api/space-weather', 'POST');
  assert.equal(res.statusCode, 405);
});

test('swpcProxy merges Kp + alerts and caches', async () => {
  const now = Date.parse('2026-09-27T06:00:00Z');
  const { fetchImpl, calls } = fakeFetch(KP_FIXTURE, ALERTS_FIXTURE(now));
  const proxy = swpcProxy({ fetchImpl, now: () => now });
  const res = await callHandler(proxy, '/api/space-weather');
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.kp, 6);
  assert.equal(doc.gScale, 'G2');
  assert.equal(doc.alerts.length, 1);
  assert.ok(calls.some((u) => u.includes('planetary_k_index_1m.json')));
  const again = await callHandler(proxy, '/api/space-weather');
  assert.equal(again.statusCode, 200);
  assert.equal(calls.length, 2, 'one Kp + one alerts fetch, then cached');
});

test('swpcProxy survives a failing alerts feed', async () => {
  const now = Date.parse('2026-09-27T06:00:00Z');
  const { fetchImpl } = fakeFetch(KP_FIXTURE, [], { alertsFail: true });
  const proxy = swpcProxy({ fetchImpl, now: () => now });
  const res = await callHandler(proxy, '/api/space-weather');
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.kp, 6);
  assert.deepEqual(doc.alerts, []);
});
