import assert from 'node:assert/strict';
import test from 'node:test';
import {
  kpToGScale,
  parseKpPayload,
  parseAlertsPayload,
  parseSolarWindSpeedPayload,
  parseSolarWindMagPayload,
  parseKp3HourPayload,
  parseKpForecastPayload,
  parseScalesPayload,
  xrayClass,
  parseXrayPayload,
  parseHamqslPayload,
  parseWwvPayload,
  parseGfzPayload,
  parseGoesParticlesPayload,
  parseGoesMagnetometersPayload,
  parseOvationPayload,
  parseGeoelectricPayload,
  parseSilsoPayload,
  swpcProxy,
} from './swpc.js';

const FIXTURES = {
  kp: [
    { time_tag: '2026-09-27T19:00:00Z', kp_index: 0.67, estimated_kp: 0.67 },
    { time_tag: '2026-09-27T19:35:00Z', kp_index: 1.33, estimated_kp: 1.33 },
  ],
  alerts: [
    {
      product_id: 'WWV_20260927',
      issue_datetime: '2026-09-27 18:05:00',
      message:
        'Space Weather Message Code: SUMSUD\r\nSerial Number: 1234\r\nSUMMARY: Solar Activity 24 hr Summary\r\nBody text here.',
    },
  ],
  speed: [{ proton_speed: 391, time_tag: '2026-09-27T19:29:00Z' }],
  mag: [{ bt: 2, bz_gsm: 0, time_tag: '2026-09-27T19:29:00Z' }],
  kp3: Array.from({ length: 10 }, (_, i) => {
    const h = i * 3;
    return {
      time_tag: `${h < 24 ? '2026-09-27' : '2026-09-28'}T${String(h % 24).padStart(2, '0')}:00:00`,
      Kp: 1 + i * 0.33,
      a_running: 5 + i,
      station_count: 8,
    };
  }),
  forecast: [
    { time_tag: '2026-09-27T12:00:00', kp: 1.0, observed: 'observed', noaa_scale: null },
    { time_tag: '2026-09-27T15:00:00', kp: 0.33, observed: 'estimated', noaa_scale: null },
    { time_tag: '2026-09-27T18:00:00', kp: 1.0, observed: 'predicted', noaa_scale: null },
    { time_tag: '2026-09-27T21:00:00', kp: 2.33, observed: 'predicted', noaa_scale: null },
    { time_tag: '2026-09-28T00:00:00', kp: 3.0, observed: 'predicted', noaa_scale: null },
  ],
  scales: {
    0: {
      DateStamp: '2026-09-27',
      TimeStamp: '19:36:00',
      R: { Scale: '0', Text: 'none', MinorProb: null, MajorProb: null },
      S: { Scale: '1', Text: 'minor', Prob: null },
      G: { Scale: '0', Text: 'none' },
    },
    1: {
      DateStamp: '2026-09-27',
      TimeStamp: '19:36:00',
      R: { Scale: null, Text: null, MinorProb: '10', MajorProb: '1' },
      S: { Scale: null, Text: null, Prob: '1' },
      G: { Scale: '0', Text: 'none' },
    },
  },
  xray: [
    { time_tag: '2026-09-27T19:35:00Z', satellite: 18, flux: 3.3e-8, energy: '0.05-0.4nm' },
    { time_tag: '2026-09-27T19:35:00Z', satellite: 18, flux: 4.408e-7, energy: '0.1-0.8nm' },
  ],
  hamqsl: `<?xml version="1.0" encoding="UTF-8" ?>
<solar>
\t<solardata>
\t\t<updated> 27 Sep 2026 1939 GMT</updated>
\t\t<solarflux>101</solarflux>
\t\t<aindex> 12</aindex>
\t\t<kindex> 0</kindex>
\t\t<xray>B4.4</xray>
\t</solardata>
</solar>`,
  wwv: `:Product: Geophysical Alert Message wwv.txt
:Issued: 2026 Sep 27 1805 UTC
#
Solar-terrestrial indices for 26 September follow.
Solar flux 101 and estimated planetary A-index 12.
`,
  gfz: `# header line one
# header line two
2026 09 26 34602 34602.5 2633 25  3.667  3.333  2.667  2.667  1.000  1.000  2.000  2.667   22   18   12   12    4    4    7   12    11  61    101.0    101.5 0
2026 09 27 34603 34603.5 2633 26  4.333  3.000  1.333  1.000  1.000  0.333  0.333 -1.000   32   15    5    4    4    2    2   -1    -1  56     -1.0     -1.0 0
`,
  // Wave B item 44 — shapes verified against the live endpoints 2026-09-27
  protons: [
    { time_tag: '2026-09-26T21:10:00Z', satellite: 18, flux: 6.849133491516113, energy: '>=1 MeV' },
    { time_tag: '2026-09-27T21:00:00Z', satellite: 18, flux: 0.23281621932983398, energy: '>=60 MeV' },
    { time_tag: '2026-09-27T21:00:00Z', satellite: 18, flux: 0.003911, energy: '>=10 MeV' },
    { time_tag: '2026-09-27T21:00:00Z', satellite: 18, flux: 0.000012, energy: '>=100 MeV' },
  ],
  electrons: [
    { time_tag: '2026-09-27T15:15:00Z', satellite: 19, flux: 2135.727783203125, energy: '>=2 MeV' },
    { time_tag: '2026-09-27T21:00:00Z', satellite: 19, flux: 2264.36474609375, energy: '>=2 MeV' },
    { time_tag: '2026-09-27T21:00:00Z', satellite: 19, flux: 118803.44, energy: '>=0.8 MeV' },
  ],
  goesMag: [
    { time_tag: '2026-09-24T21:11:00Z', satellite: 19, He: 36.9, Hp: 92.84, Hn: -6.59, total: 100.13, arcjet_flag: false },
    { time_tag: '2026-09-27T21:08:00Z', satellite: 19, He: 38.69209671020508, Hp: 95.68415069580078, Hn: -2.0508511066436768, total: 103.23173522949219, arcjet_flag: false },
  ],
  ovation: {
    'Observation Time': '2026-09-27T20:59:00Z',
    'Forecast Time': '2026-09-27T22:11:00Z',
    'Data Format': '[Longitude, Latitude, Aurora]',
    coordinates: [
      [0, -90, 2],
      [0, -89, 0],
      [0, -88, 3],
      [1, -88, 45],
    ],
    type: 'MultiPoint',
  },
  geoelectric: [
    { url: '/images/animations/geoelectric/InterMagEarthScope/EmapGraphics_1m/20260927T180930-16-emap-empirical-EMTF-2022.12-v2022.12.png', time_tag: '2026-09-27T18:09:30Z' },
    { url: '/images/animations/geoelectric/InterMagEarthScope/EmapGraphics_1m/20260927T181030-16-emap-empirical-EMTF-2022.12-v2022.12.png', time_tag: '2026-09-27T18:10:30Z' },
  ],
  silso: `# SILSO daily total sunspot number header
2026  9 26  2026.726  83.0   4.1   30    1
2026  9 27  2026.729  95.0   5.4   31    0
`,
};

test('kpToGScale maps Kp to the NOAA G scale', () => {
  assert.equal(kpToGScale(0), 'G0');
  assert.equal(kpToGScale(4.99), 'G0');
  assert.equal(kpToGScale(5), 'G1');
  assert.equal(kpToGScale(6.5), 'G2');
  assert.equal(kpToGScale(7), 'G3');
  assert.equal(kpToGScale(8.99), 'G4');
  assert.equal(kpToGScale(9), 'G5');
  assert.equal(kpToGScale(NaN), null);
  assert.equal(kpToGScale(null), null);
});

test('parseKpPayload takes the latest 1-min entry', () => {
  const out = parseKpPayload(FIXTURES.kp);
  assert.equal(out.kp, 1.33);
  assert.equal(out.estimatedKp, 1.33);
  assert.equal(out.gScale, 'G0');
  assert.ok(Number.isFinite(out.timeTagMs));
  assert.throws(() => parseKpPayload([]), /swpc_kp_unexpected_shape/);
});

test('parseAlertsPayload keeps recent alerts with headlines', () => {
  const out = parseAlertsPayload(FIXTURES.alerts, Date.parse('2026-09-27T20:00:00Z'));
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'SUMSUD');
  assert.ok(out[0].headline.includes('SUMMARY'));
  assert.throws(() => parseAlertsPayload(null), /swpc_alerts_unexpected_shape/);
});

test('parseSolarWindSpeedPayload / parseSolarWindMagPayload', () => {
  assert.deepEqual(parseSolarWindSpeedPayload(FIXTURES.speed), {
    speed: 391,
    timeTagMs: Date.parse('2026-09-27T19:29:00Z'),
  });
  assert.deepEqual(parseSolarWindMagPayload(FIXTURES.mag), {
    bt: 2,
    bz: 0,
    timeTagMs: Date.parse('2026-09-27T19:29:00Z'),
  });
  assert.throws(() => parseSolarWindSpeedPayload([{ proton_speed: 'bad' }]), /swpc_swspeed_missing/);
});

test('parseKp3HourPayload keeps the last 8 entries, chronological', () => {
  const out = parseKp3HourPayload(FIXTURES.kp3);
  assert.equal(out.length, 8);
  assert.ok(out[0].kp < out[out.length - 1].kp);
  assert.ok(out.every((e) => Number.isFinite(e.kp) && Number.isFinite(e.timeTagMs)));
  assert.throws(() => parseKp3HourPayload([]), /swpc_kp3h_unexpected_shape/);
});

test('parseKpForecastPayload keeps only predicted entries', () => {
  const out = parseKpForecastPayload(FIXTURES.forecast);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((e) => e.kp), [1.0, 2.33, 3.0]);
  assert.ok(out.every((e) => e.noaaScale === null));
});

test('parseScalesPayload reads current scales and 24h outlook', () => {
  const out = parseScalesPayload(FIXTURES.scales);
  assert.deepEqual(out.r, { scale: '0', text: 'none' });
  assert.deepEqual(out.s, { scale: '1', text: 'minor' });
  assert.deepEqual(out.g, { scale: '0', text: 'none' });
  assert.deepEqual(out.outlook, { rMinorProb: 10, rMajorProb: 1, sProb: 1 });
  assert.throws(() => parseScalesPayload(null), /swpc_scales_unexpected_shape/);
});

test('xrayClass maps flux to GOES letter classes', () => {
  assert.equal(xrayClass(4.408e-7), 'B4.4');
  assert.equal(xrayClass(1.2e-4), 'X1.2');
  assert.equal(xrayClass(5e-6), 'C5.0');
  assert.equal(xrayClass(3e-9), 'A0.3');
  assert.equal(xrayClass(0), null);
  assert.equal(xrayClass(NaN), null);
});

test('parseXrayPayload takes the latest 0.1-0.8nm reading', () => {
  const out = parseXrayPayload(FIXTURES.xray);
  assert.equal(out.flux, 4.408e-7);
  assert.equal(out.class, 'B4.4');
  assert.equal(out.timeTagMs, Date.parse('2026-09-27T19:35:00Z'));
  assert.throws(
    () => parseXrayPayload([{ flux: 1e-7, energy: '0.05-0.4nm' }]),
    /swpc_xray_missing_channel/,
  );
});

test('parseHamqslPayload extracts SFI/A/K from the XML', () => {
  assert.deepEqual(parseHamqslPayload(FIXTURES.hamqsl), {
    sfi: 101,
    aIndex: 12,
    kIndex: 0,
    updated: '27 Sep 2026 1939 GMT',
  });
  assert.throws(() => parseHamqslPayload('<solar></solar>'), /swpc_hamqsl_missing/);
});

test('parseWwvPayload keeps the issued line and a trimmed body', () => {
  const out = parseWwvPayload(FIXTURES.wwv);
  assert.equal(out.issued, '2026 Sep 27 1805 UTC');
  assert.ok(out.text.startsWith(':Product:'));
  assert.ok(out.text.length <= 1600);
  assert.throws(() => parseWwvPayload('   '), /swpc_wwv_empty/);
});

test('parseGfzPayload takes the latest non-sentinel Kp block', () => {
  const out = parseGfzPayload(FIXTURES.gfz);
  // last line: Kp7 = 0.333 (idx 6), ap7 = 2; Kp8 = -1.000 sentinel
  assert.equal(out.kp, 0.333);
  assert.equal(out.ap, 2);
  assert.equal(out.timeTagMs, Date.UTC(2026, 8, 27, 18, 0, 0));
  assert.throws(() => parseGfzPayload('# only headers\n'), /swpc_gfz_empty/);
});

// ---- proxy integration (mocked fetch) ----

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    listeners: {},
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(body) {
      chunks.push(body);
      res.body = chunks.join('');
    },
    once() {},
    removeListener() {},
  };
  return res;
}

function fakeReq(method = 'GET') {
  return { method, url: '/api/space-weather' };
}

function okResponse(bodyText) {
  return {
    ok: true,
    headers: { get: () => null },
    text: async () => bodyText,
  };
}

const TEXT_URLS = new Set([
  'https://www.hamqsl.com/solarxml.php',
  'https://services.swpc.noaa.gov/text/wwv.txt',
  'https://kp.gfz-potsdam.de/app/files/Kp_ap_Ap_SN_F107_nowcast.txt',
]);

function fixtureFor(url) {
  if (url.includes('planetary_k_index_1m')) return JSON.stringify(FIXTURES.kp);
  if (url.includes('products/alerts')) return JSON.stringify(FIXTURES.alerts);
  if (url.includes('solar-wind-speed')) return JSON.stringify(FIXTURES.speed);
  if (url.includes('solar-wind-mag-field')) return JSON.stringify(FIXTURES.mag);
  if (url.includes('noaa-planetary-k-index-forecast')) return JSON.stringify(FIXTURES.forecast);
  if (url.includes('noaa-planetary-k-index')) return JSON.stringify(FIXTURES.kp3);
  if (url.includes('noaa-scales')) return JSON.stringify(FIXTURES.scales);
  if (url.includes('xrays-1-day')) return JSON.stringify(FIXTURES.xray);
  if (url.includes('hamqsl')) return FIXTURES.hamqsl;
  if (url.includes('wwv.txt')) return FIXTURES.wwv;
  if (url.includes('gfz-potsdam')) return FIXTURES.gfz;
  // Wave B item 44 fixtures (shapes verified against the live endpoints 2026-09-27)
  if (url.includes('integral-protons-1-day')) return JSON.stringify(FIXTURES.protons);
  if (url.includes('integral-electrons-6-hour')) return JSON.stringify(FIXTURES.electrons);
  if (url.includes('magnetometers-3-day')) return JSON.stringify(FIXTURES.goesMag);
  if (url.includes('ovation_aurora_latest')) return JSON.stringify(FIXTURES.ovation);
  if (url.includes('geoelectric/InterMagEarthScope.json')) return JSON.stringify(FIXTURES.geoelectric);
  if (url.includes('SN_d_tot_V2.0.txt')) return FIXTURES.silso;
  throw new Error(`unknown fixture url: ${url}`);
}

/** Mock fetch: optional `failUrls` set makes those upstreams 500; records fetch options. */
function mockFetch({ failUrls = new Set(), seen = [] } = {}) {
  return async (url, options) => {
    seen.push({ url, options });
    if (failUrls.has(url)) return { ok: false, status: 500, body: { cancel: async () => {} } };
    return okResponse(fixtureFor(url));
  };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({
    middlewares: { use: (route, handler) => calls.push({ route, handler }) },
  });
  return calls;
}

test('handler rejects non-GET with 405', async () => {
  const seen = [];
  const provider = swpcProxy({ fetchImpl: mockFetch({ seen }), now: () => 1_000_000 });
  const calls = mount(provider);
  assert.equal(calls[0].route, '/api/space-weather');
  const res = fakeRes();
  await calls[0].handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});

test('handler returns the full ticker payload on success', async () => {
  const seen = [];
  const provider = swpcProxy({ fetchImpl: mockFetch({ seen }), now: () => 1_000_000 });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.schemaVersion, 2);
  assert.ok(doc.generatedAt);
  assert.equal(doc.unavailable, false);
  assert.equal(doc.stale, false);
  // legacy flat fields preserved for the Wave 3 glow
  assert.equal(doc.kp, 1.33);
  assert.equal(doc.gScale, 'G0');
  assert.equal(doc.alerts.length, 1);
  // new ticker blocks
  assert.deepEqual(doc.solarWind.speed, 391);
  assert.deepEqual(doc.solarWind.bz, 0);
  assert.deepEqual(doc.kpThreeHour.length, 8);
  assert.deepEqual(doc.kpForecast.length, 3);
  assert.deepEqual(doc.scales.r, { scale: '0', text: 'none' });
  assert.deepEqual(doc.xray.class, 'B4.4');
  assert.deepEqual(doc.hamqsl.sfi, 101);
  assert.equal(doc.wwv.issued, '2026 Sep 27 1805 UTC');
  assert.equal(doc.gfz.kp, 0.333);
  // every upstream fetch followed redirects (workerd rejects redirect:'error')
  assert.ok(seen.length >= 11);
  assert.ok(seen.every((s) => s.options.redirect === 'follow'));
});

test('a failed side feed degrades to null without failing the route', async () => {
  const provider = swpcProxy({
    fetchImpl: mockFetch({ failUrls: new Set(['https://www.hamqsl.com/solarxml.php']) }),
    now: () => 1_000_000,
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.unavailable, false);
  assert.equal(doc.hamqsl, null);
  assert.equal(doc.xray.class, 'B4.4'); // other feeds still present
});

test('a failed Kp core feed yields unavailable when there is no cache', async () => {
  const provider = swpcProxy({
    fetchImpl: mockFetch({
      failUrls: new Set(['https://services.swpc.noaa.gov/json/planetary_k_index_1m.json']),
    }),
    now: () => 1_000_000,
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.unavailable, true);
  assert.equal(doc.kp, null);
  assert.ok(/unreachable/.test(doc.reason));
});

// ——— Wave B item 44: GOES/Ovation/geoelectric/SILSO ———

test('parseGoesParticlesPayload collects every energy channel of the latest timestamp', () => {
  const p = parseGoesParticlesPayload(FIXTURES.protons);
  assert.equal(p.timeTag, '2026-09-27T21:00:00Z');
  assert.equal(p.satellite, 18);
  assert.deepEqual(Object.keys(p.bands).sort(), ['>=10 MeV', '>=100 MeV', '>=60 MeV']);
  assert.ok(Math.abs(p.bands['>=60 MeV'] - 0.23281621932983398) < 1e-12);
  // an older timestamp's channel must not leak in
  assert.ok(!('>=1 MeV' in p.bands));
  const e = parseGoesParticlesPayload(FIXTURES.electrons);
  assert.equal(e.timeTag, '2026-09-27T21:00:00Z');
  assert.deepEqual(Object.keys(e.bands).sort(), ['>=0.8 MeV', '>=2 MeV']);
  assert.throws(() => parseGoesParticlesPayload([]), /unexpected_shape/);
  assert.throws(() => parseGoesParticlesPayload(null), /unexpected_shape/);
});

test('parseGoesMagnetometersPayload takes the latest row', () => {
  const m = parseGoesMagnetometersPayload(FIXTURES.goesMag);
  assert.equal(m.timeTag, '2026-09-27T21:08:00Z');
  assert.equal(m.satellite, 19);
  assert.ok(Math.abs(m.total - 103.23173522949219) < 1e-9);
  assert.ok(Math.abs(m.hn - -2.0508511066436768) < 1e-9);
  assert.equal(m.arcjetFlag, false);
  assert.throws(() => parseGoesMagnetometersPayload([]), /unexpected_shape/);
});

test('parseOvationPayload summarizes the grid instead of shipping it', () => {
  const o = parseOvationPayload(FIXTURES.ovation);
  assert.equal(o.observationTime, '2026-09-27T20:59:00Z');
  assert.equal(o.forecastTime, '2026-09-27T22:11:00Z');
  assert.equal(o.totalCells, 4);
  assert.equal(o.activeCells, 3);
  assert.equal(o.maxAurora, 45);
  assert.ok(!('coordinates' in o));
  assert.throws(() => parseOvationPayload({ coordinates: [] }), /no_cells/);
});

test('parseGeoelectricPayload absolutizes frame urls', () => {
  const g = parseGeoelectricPayload(FIXTURES.geoelectric);
  assert.equal(g.count, 2);
  assert.equal(g.latest.timeTag, '2026-09-27T18:10:30Z');
  assert.ok(g.latest.url.startsWith('https://services.swpc.noaa.gov/images/animations/geoelectric/'));
  assert.equal(g.frames.length, 2);
  assert.throws(() => parseGeoelectricPayload([]), /unexpected_shape/);
});

test('parseSilsoPayload reads the last data line of the daily file', () => {
  const s = parseSilsoPayload(FIXTURES.silso);
  assert.equal(s.date, '2026-09-27');
  assert.equal(s.sunspotNumber, 95);
  assert.equal(s.observations, 31);
  assert.equal(s.definitive, false); // trailing 0 = provisional
  const missing = parseSilsoPayload('2026  9 28  2026.732  -1.0  -1.0    0    0\n');
  assert.equal(missing.sunspotNumber, null);
  assert.throws(() => parseSilsoPayload('# only a header\n'), /no_data_line/);
});

test('handler includes the item-44 blocks and every fetch used redirect follow', async () => {
  const seen = [];
  const provider = swpcProxy({ fetchImpl: mockFetch({ seen }), now: () => 1_000_000 });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.unavailable, false);
  assert.ok(Math.abs(doc.goesParticles.protons.bands['>=60 MeV'] - 0.23281621932983398) < 1e-12);
  assert.ok(Math.abs(doc.goesParticles.electrons.bands['>=2 MeV'] - 2264.36474609375) < 1e-9);
  assert.ok(Math.abs(doc.goesMagnetometers.total - 103.23173522949219) < 1e-9);
  assert.equal(doc.ovation.maxAurora, 45);
  assert.equal(doc.geoelectric.count, 2);
  assert.equal(doc.silso.date, '2026-09-27');
  assert.equal(doc.silso.sunspotNumber, 95);
  assert.ok(seen.length >= 17);
  assert.ok(seen.every((s) => s.options.redirect === 'follow'));
});

test('item-44 side feeds failing degrade to null without failing the route', async () => {
  const provider = swpcProxy({
    fetchImpl: mockFetch({
      failUrls: new Set([
        'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json',
        'https://www.sidc.be/silso/DATA/SN_d_tot_V2.0.txt',
      ]),
    }),
    now: () => 1_000_000,
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.unavailable, false);
  assert.equal(doc.ovation, null);
  assert.equal(doc.silso, null);
  assert.ok(doc.goesParticles.protons != null);
});
