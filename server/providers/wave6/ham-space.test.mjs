import assert from 'node:assert/strict';
import test from 'node:test';
import { hamSpaceProxy, _hamSpaceInternals } from './ham-space.js';

const {
  trimArissPage,
  trimEcallistoListing,
  ecallistoDayUrl,
  buildSnapshot,
  clearCaches,
} = _hamSpaceInternals;

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
  return { method, url: '/api/ham-space', on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('hamSpaceProxy mounts /api/ham-space on both server shapes', () => {
  const routes = mount(hamSpaceProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/ham-space', '/api/ham-space']);
});

const ARISS_FIXTURE = `<html><head><title>Current Status of ISS Stations - ARISS</title></head>
<body>
<h1>ISS Ham Radio Status</h1>
<p>NA1SS voice operations are currently active on 145.990 MHz uplink and 437.800 MHz downlink.</p>
<p>RS0ISS APRS digipeater is running on 437.825 MHz.</p>
<p>This page was last updated recently and also mentions the weather.</p>
</body></html>`;

test('trimArissPage extracts callsign/frequency lines and the MHz list', () => {
  const d = trimArissPage(ARISS_FIXTURE, 'https://ariss.org/x');
  assert.equal(d.title, 'Current Status of ISS Stations - ARISS');
  assert.deepEqual(d.frequencies, ['145.990', '437.800', '437.825']);
  assert.ok(d.notes.length >= 2, 'voice + APRS lines must survive the keyword filter');
  assert.ok(d.notes.every((n) => /NA1SS|RS0ISS|MHz|APRS/i.test(n)));
  assert.ok(!d.notes.some((n) => /weather/.test(n) && !/NA1SS|RS0ISS|MHz|kHz|APRS|packet|voice|cross/i.test(n)),
    'non-keyword lines are dropped');
});

const ECALLISTO_FIXTURE = `<html><body><pre>
<a href="?C=N;O=D">Name</a>
<a href="/solarradio/data/2002-20yy_Callisto/2026/09/26/">Parent Directory</a>
<a href="BIR_20260926_093000_59.fit.gz">BIR_20260926_093000_59.fit.gz</a>
<a href="BIR_20260926_094500_59.fit.gz">BIR_20260926_094500_59.fit.gz</a>
<a href="ALMATY_20260926_060015_15.fit.gz">ALMATY_20260926_060015_15.fit.gz</a>
<a href="readme.txt">readme.txt</a>
</pre></body></html>`;

test('trimEcallistoListing groups spectrograms per station with latest timestamp', () => {
  const d = trimEcallistoListing(ECALLISTO_FIXTURE, 'https://soleil.i4ds.ch/x/', '2026-09-26');
  assert.equal(d.day, '2026-09-26');
  assert.equal(d.totalFiles, 3, 'readme.txt and nav links are not spectrograms');
  assert.equal(d.stationCount, 2);
  const bir = d.stations.find((s) => s.station === 'BIR');
  assert.ok(bir);
  assert.equal(bir.files, 2);
  assert.equal(bir.latest, '2026-09-26T09:45:00Z');
  const almaty = d.stations.find((s) => s.station === 'ALMATY');
  assert.ok(almaty);
  assert.equal(almaty.files, 1);
  // Sorted by file count descending.
  assert.equal(d.stations[0].station, 'BIR');
});

test('ecallistoDayUrl builds the dated Apache path from UTC', () => {
  const { day, url } = ecallistoDayUrl(new Date(Date.UTC(2026, 8, 27, 12, 0, 0)));
  assert.equal(day, '2026-09-27');
  assert.equal(url, 'https://soleil.i4ds.ch/solarradio/data/2002-20yy_Callisto/2026/09/27/');
});

test('buildSnapshot merges ok sources and records failed ones honestly', () => {
  const snap = buildSnapshot([
    { key: 'ariss', ok: true, attribution: 'ARISS', latencyMs: 10, data: { notes: ['x'] } },
    { key: 'ecallisto', ok: false, attribution: 'e-Callisto', latencyMs: 5, error: 'boom' },
  ]);
  assert.ok(Date.parse(snap.generatedAt) > 0);
  assert.equal(snap.sources.ariss.ok, true);
  assert.equal(snap.sources.ecallisto.ok, false);
  assert.equal(snap.sources.ecallisto.error, 'boom');
  assert.deepEqual(snap.ariss, { notes: ['x'] });
  assert.equal(snap.ecallisto, undefined, 'failed source contributes no data section');
});

test('handler returns 502 only when every source fails', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  const down = async (url) => {
    // ARISS down, e-Callisto listing up.
    if (String(url).includes('ariss.org')) return new Response('down', { status: 503 });
    return new Response(ECALLISTO_FIXTURE, { status: 200, headers: { 'Content-Type': 'text/html' } });
  };
  globalThis.fetch = down;
  try {
    const [{ handler }] = mount(hamSpaceProxy());
    const res = fakeRes();
    await handler(fakeReq('GET'), res);
    assert.equal(res.statusCode, 200, 'partial success is still 200');
    const body = JSON.parse(res.body);
    assert.equal(body.sources.ariss.ok, false);
    assert.equal(body.sources.ecallisto.ok, true);
    assert.equal(body.ecallisto.stationCount, 2);
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }

  clearCaches();
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const [{ handler }] = mount(hamSpaceProxy());
    const res = fakeRes();
    await handler(fakeReq('GET'), res);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error, 'hamspace_unavailable');
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
