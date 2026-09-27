import assert from 'node:assert/strict';
import test from 'node:test';
import { dsnProxy, _dsnInternals } from './dsn.js';

const { parseDsn, parseSignal, trimDsnPayload } = _dsnInternals;

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

// Carved from the live dsn.xml capture (eyes.nasa.gov, 2026-09-27 17:09 EDT).
const SAMPLE_XML = `<dsn>
\t<station name="gdscc" friendlyName="Goldstone" timeUTC="1790543875000" timeZoneOffset="-25200000.0"/>
\t<dish name="DSS14" azimuthAngle="0" elevationAngle="90" windSpeed="" isMSPA="false" isArray="false" isDDOR="false" activity="Engineering Upgrades">
\t\t<target name="DSN" id="99" uplegRange="-1" downlegRange="-1" rtlt="-1"/>
\t</dish>
\t<dish name="DSS24" azimuthAngle="286" elevationAngle="14" windSpeed="25" isMSPA="false" isArray="false" isDDOR="false" activity="Spacecraft Telemetry, Tracking, and Command">
\t\t<upSignal active="false" signalType="none" dataRate="0" frequency="0" band="X" power="0" spacecraft="TGO" spacecraftID="-143"/>
\t\t<downSignal active="true" signalType="data" dataRate="625000" frequency="0" band="X" power="-120" spacecraft="TGO" spacecraftID="-143"/>
\t\t<target name="TGO" id="143" uplegRange="-1" downlegRange="-1" rtlt="-1"/>
\t</dish>
\t<station name="mdscc" friendlyName="Madrid" timeUTC="1790543875000" timeZoneOffset="3600000.0"/>
\t<dish name="DSS65" azimuthAngle="105" elevationAngle="33" windSpeed="8" isMSPA="false" isArray="false" isDDOR="false" activity="Spacecraft Telemetry, Tracking, and Command">
\t\t<upSignal active="true" signalType="data" dataRate="0" frequency="0" band="S" power="0.2" spacecraft="KPLO" spacecraftID="-155"/>
\t\t<downSignal active="true" signalType="data" dataRate="8192" frequency="0" band="S" power="-120" spacecraft="KPLO" spacecraftID="-155"/>
\t\t<downSignal active="false" signalType="none" dataRate="0" frequency="0" band="X" power="-140" spacecraft="KPLO" spacecraftID="-155"/>
\t\t<target name="KPLO" id="155" uplegRange="372000" downlegRange="372000" rtlt="-1"/>
\t</dish>
\t<timestamp>1790543875000</timestamp>
</dsn>`;

test('dsnProxy mounts /api/dsn on both server shapes', () => {
  const routes = mount(dsnProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/dsn', '/api/dsn']);
});

test('parseSignal trims one signal element', () => {
  const s = parseSignal('active="true" signalType="data" dataRate="625000" frequency="0" band="X" power="-120" spacecraft="TGO" spacecraftID="-143"');
  assert.equal(s.active, true);
  assert.equal(s.band, 'X');
  assert.equal(s.dataRateBps, 625000);
  assert.equal(s.powerDbm, -120);
  assert.equal(s.spacecraft, 'TGO');
  assert.equal(s.spacecraftID, -143);
});

test('parseDsn extracts stations and dishes from the live shape', () => {
  const { stations, dishes } = parseDsn(SAMPLE_XML);
  assert.equal(stations.length, 2);
  assert.equal(stations[0].friendlyName, 'Goldstone');
  assert.equal(stations[0].timeISO, new Date(1790543875000).toISOString());
  assert.equal(stations[1].friendlyName, 'Madrid');
  assert.equal(dishes.length, 3);

  const idle = dishes.find((d) => d.name === 'DSS14');
  assert.equal(idle.tracking, false);
  assert.equal(idle.activity, 'Engineering Upgrades');
  assert.equal(idle.elevationDeg, 90);
  assert.equal(idle.target.name, 'DSN');
  assert.equal(idle.downSignals.length, 0);
});

test('parseDsn marks dishes with an active downlink as tracking', () => {
  const { dishes } = parseDsn(SAMPLE_XML);
  const dss24 = dishes.find((d) => d.name === 'DSS24');
  assert.equal(dss24.tracking, true);
  assert.equal(dss24.azimuthDeg, 286);
  assert.equal(dss24.windSpeed, 25);
  assert.equal(dss24.downSignals.length, 1);
  assert.equal(dss24.downSignals[0].dataRateBps, 625000);
  assert.equal(dss24.target.name, 'TGO');

  const dss65 = dishes.find((d) => d.name === 'DSS65');
  assert.equal(dss65.downSignals.length, 2);
  assert.equal(dss65.target.uplegRangeKm, 372000);
  assert.equal(dss65.mspa, false);
});

test('parseDsn tolerates missing/empty attributes', () => {
  const { dishes } = parseDsn('<dsn><dish name="X"/></dsn>');
  assert.equal(dishes.length, 1);
  assert.equal(dishes[0].windSpeed, null);
  assert.equal(dishes[0].tracking, false);
  assert.equal(dishes[0].target, null);
});

test('trimDsnPayload counts tracking dishes and lists active spacecraft', () => {
  const payload = trimDsnPayload(SAMPLE_XML);
  assert.equal(payload.dishCount, 3);
  assert.equal(payload.trackingCount, 2);
  const names = payload.activeSpacecraft.map((s) => s.name);
  assert.ok(names.includes('TGO'));
  assert.ok(names.includes('KPLO'));
  const tgo = payload.activeSpacecraft.find((s) => s.name === 'TGO');
  assert.equal(tgo.dish, 'DSS24');
  assert.equal(tgo.dataRateBps, 625000);
});

test('handler serves trimmed DSN snapshot with mocked fetch', async () => {
  _dsnInternals.clearCaches();
  const calls = mount(dsnProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(SAMPLE_XML, { status: 200, headers: { 'Content-Type': 'application/xml' } });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/dsn'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.dishCount, 3);
    assert.equal(payload.trackingCount, 2);
    assert.match(res.headers['Cache-Control'], /max-age=60/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when the feed is down', async () => {
  _dsnInternals.clearCaches();
  const calls = mount(dsnProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/dsn'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /dsn_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(dsnProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/dsn', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
