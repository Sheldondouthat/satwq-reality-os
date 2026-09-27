import assert from 'node:assert/strict';
import test from 'node:test';
import { alertsProxy, _alertsInternals } from './alerts.js';

const { parseNwsAlerts, parseDwdJsonp, parseDwdAlerts, buildSnapshot, clearCaches } = _alertsInternals;

const DWD_EMPTY_OBSERVED =
  'warnWetter.loadWarnings({"time":1790542805000,"warnings":{},"vorabInformation":{},"copyright":"Copyright Deutscher Wetterdienst"});';

const DWD_ACTIVE = 'warnWetter.loadWarnings(' + JSON.stringify({
  time: 1790542805000,
  warnings: {
    801111000: [
      {
        regionName: 'Nordfriesische Inseln',
        start: 1790542805000,
        end: 1790560000000,
        type: 1,
        severity: 1,
        level: 3,
        type2: null,
        description: 'Es treten Sturmböen mit Geschwindigkeiten bis 80 km/h auf.',
        headline: 'Amtliche WARNUNG vor STURMBÖEN',
        instruction: 'Sichern Sie lose Gegenstände.',
        event: 'STURMBÖEN',
        altseaLevel: ' ',
        state: 'Schleswig-Holstein',
        stateShort: 'SH',
        altitudeStart: null,
        altitudeEnd: null,
        areaID: '801111000',
        i18nTitle: { en: 'GALE-FORCE WINDS', de: 'STURMBÖEN' },
      },
      { regionName: 'X', start: 'not-a-number' }, // dropped: bad start
    ],
  },
  vorabInformation: {
    809999000: [
      {
        regionName: 'Kreis Plön',
        start: 1790570000000,
        end: 1790580000000,
        level: 2,
        description: 'Vorabinformation Unwetter.',
        headline: 'Vorabinformation',
        event: 'STARKREGEN',
        state: 'Schleswig-Holstein',
        areaID: '809999000',
        i18nTitle: { en: 'HEAVY RAIN' },
      },
    ],
  },
  copyright: 'Copyright Deutscher Wetterdienst',
}) + ');';

const NWS_FIXTURE = {
  features: [
    {
      id: 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.abc',
      properties: {
        event: 'Tornado Warning',
        headline: 'Tornado Warning issued',
        description: 'x'.repeat(3000),
        severity: 'Extreme',
        certainty: 'Observed',
        urgency: 'Immediate',
        effective: '2026-09-27T20:00:00Z',
        expires: '2026-09-27T21:00:00Z',
        senderName: 'NWS Blacksburg VA',
        areaDesc: 'Giles County; Montgomery County',
      },
    },
    { id: 'no-props-at-all', properties: {} }, // dropped: no event
  ],
};

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

function fakeReq(method = 'GET') {
  return { method, url: '/api/alerts', headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('parseDwdJsonp unwraps the observed live payload (zero warnings)', () => {
  const payload = parseDwdJsonp(DWD_EMPTY_OBSERVED);
  assert.equal(payload.time, 1790542805000);
  assert.deepEqual(payload.warnings, {});
  assert.match(payload.copyright, /Deutscher Wetterdienst/);
});

test('parseDwdJsonp throws on non-JSONP text', () => {
  assert.throws(() => parseDwdJsonp('not jsonp at all'), /jsonp_unwrap/);
});

test('parseDwdAlerts normalizes warnings + vorabInformation, drops bad rows', () => {
  const out = parseDwdAlerts(parseDwdJsonp(DWD_ACTIVE));
  assert.equal(out.length, 2);
  const [warn, pre] = out;
  assert.equal(warn.source, 'dwd');
  assert.equal(warn.id, 'dwd:801111000:1790542805000');
  assert.equal(warn.event, 'GALE-FORCE WINDS'); // English title preferred
  assert.equal(warn.eventDe, 'STURMBÖEN');
  assert.equal(warn.severity, 'Severe'); // level 3 → Severe
  assert.equal(warn.dwdLevel, 3);
  assert.equal(warn.effective, new Date(1790542805000).toISOString());
  assert.equal(warn.expires, new Date(1790560000000).toISOString());
  assert.equal(warn.area, 'Nordfriesische Inseln — Schleswig-Holstein');
  assert.equal(warn.preliminary, false);
  assert.equal(pre.preliminary, true);
  assert.equal(pre.severity, 'Moderate'); // level 2 → Moderate
});

test('parseNwsAlerts trims and caps descriptions', () => {
  const out = parseNwsAlerts(NWS_FIXTURE);
  assert.equal(out.length, 1);
  const [a] = out;
  assert.equal(a.source, 'nws');
  assert.ok(a.id.startsWith('nws:'));
  assert.equal(a.event, 'Tornado Warning');
  assert.equal(a.severity, 'Extreme');
  assert.equal(a.area, 'Giles County; Montgomery County');
  assert.equal(a.description.length, 2001); // 2000 + ellipsis
});

test('buildSnapshot sorts most-severe first and records per-source errors', () => {
  const snap = buildSnapshot([
    {
      key: 'nws', ok: false, count: 0, attribution: 'nws', latencyMs: 5,
      error: 'alerts_nws_upstream_503', alerts: [],
    },
    {
      key: 'dwd', ok: true, count: 2, attribution: 'dwd', latencyMs: 7,
      feedTime: '2026-09-27T21:00:00.000Z', copyright: 'c', alerts: [
        { id: 'd1', source: 'dwd', severity: 'Minor', effective: '2026-09-27T20:00:00.000Z' },
        { id: 'd2', source: 'dwd', severity: 'Extreme', effective: '2026-09-27T19:00:00.000Z' },
      ],
    },
  ]);
  assert.equal(snap.count, 2);
  assert.equal(snap.alerts[0].id, 'd2'); // Extreme before Minor
  assert.deepEqual(snap.counts, { nws: 0, dwd: 2 });
  assert.equal(snap.sources.nws.ok, false);
  assert.equal(snap.sources.nws.error, 'alerts_nws_upstream_503');
  assert.equal(snap.sources.dwd.feedTime, '2026-09-27T21:00:00.000Z');
});

test('alertsProxy mounts /api/alerts on dev and preview', () => {
  const calls = mount(alertsProxy());
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.route === '/api/alerts'));
});

test('alertsProxy handler rejects non-GET with 405', async () => {
  const [{ handler }] = mount(alertsProxy());
  const res = fakeRes();
  await handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
});

test('alertsProxy maps total upstream failure to honest 502', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(Object.assign(new Error('down'), { status: 502 }));
  try {
    const [{ handler }] = mount(alertsProxy());
    const res = fakeRes();
    await handler(fakeReq(), res);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error, 'alerts_unavailable');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
