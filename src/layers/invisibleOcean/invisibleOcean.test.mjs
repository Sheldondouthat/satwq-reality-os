/**
 * Invisible Ocean (F13) unit tests.
 * Covers: great-circle math, Maidenhead conversion, spot aging/fade,
 * SWPC payload parsing (fixtures shaped like the real feeds), MUF intuition
 * sanity bounds, upstream text parsers, and the source fetch orchestration.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  maidenheadToLatLon,
  isValidGrid,
  haversineKm,
  greatCirclePath,
  arcMidpoint,
  arcApexKm,
  arcSegments,
  frequencyToBand,
  bandColor,
  normalizeSpot,
  spotAgeMs,
  spotAlpha,
  isSpotAlive,
  capSpots,
  parsePskXml,
  parseWsprHtml,
  classifyGoesXray,
  goesSubclass,
  parseEmWeather,
  estimateMuf,
  bandsUnderMuf,
  bestBandsHint,
  emWeatherSummary,
  SPOT_TTL_MS,
  MIN_ARC_KM,
} from './model.js';
import { createInvisibleOceanSource } from './source.js';
import { HONESTY_COPY } from './about.js';

// ---------------------------------------------------------------------------
// Maidenhead grid squares
// ---------------------------------------------------------------------------

test('maidenheadToLatLon converts known locators to field centers', () => {
  const jo31 = maidenheadToLatLon('JO31');
  assert.deepEqual(jo31, { lat: 51.5, lon: 7 });
  const em47 = maidenheadToLatLon('EM47');
  assert.ok(Math.abs(em47.lat - 37.5) < 1e-9);
  assert.ok(Math.abs(em47.lon + 91) < 1e-9);
});

test('maidenheadToLatLon centers 6- and 8-char subsquares', () => {
  const six = maidenheadToLatLon('JO31ab');
  assert.ok(six.lat > 51 && six.lat < 52 && six.lon > 6 && six.lon < 8);
  const eight = maidenheadToLatLon('JO31ab12');
  assert.ok(Number.isFinite(eight.lat) && Number.isFinite(eight.lon));
});

test('isValidGrid rejects garbage', () => {
  assert.equal(isValidGrid('JO31'), true);
  assert.equal(isValidGrid('jo31'), true);
  assert.equal(isValidGrid('RR73ev'), true);
  assert.equal(maidenheadToLatLon('ZZ99'), null);
  assert.equal(maidenheadToLatLon('JO3'), null);
  assert.equal(maidenheadToLatLon(''), null);
  assert.equal(maidenheadToLatLon(null), null);
});

// ---------------------------------------------------------------------------
// Great-circle math
// ---------------------------------------------------------------------------

test('haversineKm matches quarter-circumference', () => {
  const d = haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 90 });
  assert.ok(Math.abs(d - 10007.5) < 1, `got ${d}`);
});

test('greatCirclePath hits endpoints and stays on the sphere', () => {
  const a = { lat: 40.7, lon: -74 };
  const b = { lat: 51.5, lon: -0.12 };
  const path = greatCirclePath(a, b, 10);
  assert.equal(path.length, 11);
  assert.ok(Math.abs(path[0][0] - a.lon) < 1e-9 && Math.abs(path[0][1] - a.lat) < 1e-9);
  assert.ok(Math.abs(path[10][0] - b.lon) < 1e-9 && Math.abs(path[10][1] - b.lat) < 1e-9);
  // Midpoint of the path is equidistant from both endpoints.
  const mid = { lat: path[5][1], lon: path[5][0] };
  const d1 = haversineKm(a, mid);
  const d2 = haversineKm(b, mid);
  assert.ok(Math.abs(d1 - d2) < 1, `${d1} vs ${d2}`);
});

test('greatCirclePath takes the short way across the antimeridian', () => {
  const a = { lat: 0, lon: 179 };
  const b = { lat: 0, lon: -179 };
  const path = greatCirclePath(a, b, 8);
  let maxJump = 0;
  for (let i = 1; i < path.length; i++) {
    // Wrapped angular difference: crossing the antimeridian is a SMALL jump.
    const jump = Math.abs(((path[i][0] - path[i - 1][0] + 540) % 360) - 180);
    maxJump = Math.max(maxJump, jump);
  }
  assert.ok(maxJump < 45, `antimeridian jump too large: ${maxJump}`);
  const total = haversineKm(a, b);
  assert.ok(total < 500, `should be a short hop, got ${total} km`);
});

test('arcMidpoint is equidistant and arcApexKm/arcSegments stay in sane ranges', () => {
  const a = { lat: 40.7, lon: -74 };
  const b = { lat: 51.5, lon: -0.12 };
  const mid = arcMidpoint(a, b);
  assert.ok(Math.abs(haversineKm(a, mid) - haversineKm(b, mid)) < 1);
  const d = haversineKm(a, b);
  const apex = arcApexKm(d);
  assert.ok(apex >= 180 && apex <= 1200, `apex ${apex}`);
  const segs = arcSegments(d);
  assert.ok(segs >= 8 && segs <= 48, `segments ${segs}`);
  assert.ok(arcApexKm(100) < arcApexKm(8000), 'longer hops arc higher');
});

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

test('frequencyToBand maps real spot frequencies', () => {
  assert.equal(frequencyToBand(7_075_902).name, '40m');
  assert.equal(frequencyToBand(14_075_499).name, '20m');
  assert.equal(frequencyToBand(10_140_193).name, '30m');
  assert.equal(frequencyToBand(3_511_500).name, '80m');
  assert.equal(frequencyToBand(123_456), null);
  assert.equal(bandColor('40m'), '#48bb78');
});

// ---------------------------------------------------------------------------
// Spot normalization + aging
// ---------------------------------------------------------------------------

const RAW_SPOT = {
  provider: 'pskreporter',
  txCall: 'K8EAB',
  rxCall: 'K5HEX',
  txGrid: 'EM47',
  rxGrid: 'EM26',
  freqHz: 7_075_902,
  mode: 'FT8',
  snrDb: -14,
  timeMs: Date.now() - 60_000,
};

test('normalizeSpot produces canonical shape for a good spot', () => {
  const spot = normalizeSpot(RAW_SPOT);
  assert.ok(spot);
  assert.equal(spot.provider, 'pskreporter');
  assert.equal(spot.band, '40m');
  assert.ok(spot.distanceKm > MIN_ARC_KM);
  assert.ok(Number.isFinite(spot.txLat) && Number.isFinite(spot.rxLon));
  assert.match(spot.id, /^spot-[0-9a-f]+$/);
});

test('normalizeSpot drops bad grids, self-spots, and off-band frequencies', () => {
  assert.equal(normalizeSpot({ ...RAW_SPOT, txGrid: 'ZZ99' }), null);
  assert.equal(normalizeSpot({ ...RAW_SPOT, txGrid: 'EM47', rxGrid: 'EM47' }), null); // self-spot
  assert.equal(normalizeSpot({ ...RAW_SPOT, freqHz: 123_456 }), null);
  assert.equal(normalizeSpot({ ...RAW_SPOT, timeMs: NaN }), null);
  assert.equal(normalizeSpot(null), null);
});

test('spot aging: alpha fades 1 -> 0 over the TTL and dead spots are culled', () => {
  const now = Date.now();
  const fresh = { ...RAW_SPOT, timeMs: now };
  const mid = { ...RAW_SPOT, timeMs: now - SPOT_TTL_MS / 2 };
  const dead = { ...RAW_SPOT, timeMs: now - SPOT_TTL_MS - 1 };
  assert.equal(spotAlpha(fresh, now), 1);
  assert.ok(Math.abs(spotAlpha(mid, now) - 0.5) < 1e-9);
  assert.equal(spotAlpha(dead, now), 0);
  assert.equal(isSpotAlive(fresh, now), true);
  assert.equal(isSpotAlive(dead, now), false);
  assert.ok(spotAgeMs(fresh, now) >= 0);
});

test('capSpots keeps newest-first order and reports drops', () => {
  const now = Date.now();
  const spots = [3, 1, 2].map((i) => ({ ...RAW_SPOT, timeMs: now - i * 1000, id: `s${i}` }));
  const { spots: capped, dropped } = capSpots(spots, 2);
  assert.deepEqual(capped.map((s) => s.id), ['s1', 's2']);
  assert.equal(dropped, 1);
});

// ---------------------------------------------------------------------------
// Upstream text parsers (fixtures shaped like the real feeds)
// ---------------------------------------------------------------------------

const PSK_FIXTURE = `<?xml version="1.0"?>
<js><![CDATA[
<receptionReports >
  <lastSequenceNumber value="73144485817"/>
  <receptionReport receiverCallsign="K5HEX" receiverLocator="EM26ve23" senderCallsign="K8EAB" senderLocator="EM74WD" frequency="7075902" flowStartSeconds="1790481030" mode="FT8" senderDXCC="United States" sNR="-14" />
  <receptionReport receiverCallsign="KK4FL" receiverLocator="IO86ha" senderCallsign="PA3AAV" senderLocator="JO22LM" frequency="3511500" flowStartSeconds="1790481030" mode="CW" sNR="8" />
  <receptionReport receiverCallsign="BAD" receiverLocator="ZZ99" senderCallsign="NOPE" senderLocator="EM47" frequency="7075902" flowStartSeconds="1790481030" mode="FT8" />
</receptionReports>
]]></js>`;

test('parsePskXml extracts reports and skips invalid locators', () => {
  const { reports } = parsePskXml(PSK_FIXTURE, 1790481030 * 1000 + 60_000);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].txCall, 'K8EAB');
  assert.equal(reports[0].rxGrid, 'EM26ve23');
  assert.equal(reports[0].freqHz, 7075902);
  assert.equal(reports[0].timeMs, 1790481030 * 1000);
  assert.equal(reports[1].mode, 'CW');
});

const WSPR_FIXTURE = `<html><body><table>
<tr><th>Date</th><th>Call</th><th>Frequency</th><th>SNR</th><th>Drift</th><th>Grid</th><th>dBm</th><th>W</th><th>Reporter</th><th>RGrid</th><th>km</th><th>mi</th><th>Mode</th><th>Version</th></tr>
<tr><td>2026-09-27 03:50</td><td>DL2NL</td><td>10.140193</td><td>+1</td><td>0</td><td>JO31</td><td>+23</td><td>0.200</td><td>DL2ABC</td><td>JO32</td><td>120</td><td>75</td><td>WSPR-2</td><td></td></tr>
<tr><td>2026-09-27 03:49</td><td>W1XYZ</td><td>7.040090</td><td>-12</td><td>1</td><td>FN42</td><td>+37</td><td>5.000</td><td>G4XYZ</td><td>IO91</td><td>5400</td><td>3356</td><td>WSPR-2</td><td></td></tr>
</table></body></html>`;

test('parseWsprHtml extracts spot rows and skips the header', () => {
  const { reports } = parseWsprHtml(WSPR_FIXTURE);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].provider, 'wsprnet');
  assert.equal(reports[0].txCall, 'DL2NL');
  assert.equal(reports[0].rxGrid, 'JO32');
  assert.ok(Math.abs(reports[0].freqHz - 10_140_193) < 1);
  assert.equal(reports[1].txGrid, 'FN42');
});

// Real WSPRnet cells are padded with &nbsp; entities — the parser must decode them.
const WSPR_FIXTURE_NBSP = `<table>
<tr><td>&nbsp;2026-09-27 03:50&nbsp;</td><td>&nbsp;DL2NL&nbsp;</td><td>&nbsp;10.140193&nbsp;</td><td>&nbsp;+1&nbsp;</td><td>&nbsp;0&nbsp;</td><td>&nbsp;JO31&nbsp;</td><td>&nbsp;+23&nbsp;</td><td>&nbsp;0.200&nbsp;</td><td>&nbsp;DL2ABC&nbsp;</td><td>&nbsp;JO32&nbsp;</td><td>&nbsp;120&nbsp;</td><td>&nbsp;75&nbsp;</td><td>&nbsp;WSPR-2&nbsp;</td><td>&nbsp;&nbsp;</td></tr>
</table>`;

test('parseWsprHtml decodes &nbsp;-padded cells like the real olddb', () => {
  const { reports } = parseWsprHtml(WSPR_FIXTURE_NBSP);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].txCall, 'DL2NL');
  assert.equal(reports[0].txGrid, 'JO31');
  assert.equal(reports[0].rxGrid, 'JO32');
  const spot = normalizeSpot(reports[0]);
  assert.ok(spot && spot.band === '30m');
});

// ---------------------------------------------------------------------------
// SWPC EM-weather parsing (fixtures shaped like the real endpoints)
// ---------------------------------------------------------------------------

const SWPC_FIXTURES = {
  speedRows: [{ proton_speed: 452, time_tag: '2026-09-27T03:42:00Z' }],
  magRows: [{ bt: 4, bz_gsm: -2.5, time_tag: '2026-09-27T03:42:00Z' }],
  xrayRows: [
    { time_tag: '2026-09-26T21:47:00Z', flux: 4.5933632009109715e-7, energy: '0.1-0.8nm' },
    { time_tag: '2026-09-26T21:47:00Z', flux: 1.9774972770392196e-8, energy: '0.05-0.4nm' },
  ],
  kpRows: [{ time_tag: '2026-09-26T21:47:00', kp_index: 2, estimated_kp: 1.67, kp: '2M' }],
  sfiRows: [{ flux: 101, time_tag: '2026-09-26T20:00:00' }],
};

test('classifyGoesXray and goesSubclass follow the GOES scale', () => {
  assert.equal(classifyGoesXray(5e-9), 'A');
  assert.equal(classifyGoesXray(4.6e-7), 'B');
  assert.equal(goesSubclass(4.5933632009109715e-7), 'B4.6');
  assert.equal(classifyGoesXray(2e-6), 'C');
  assert.equal(classifyGoesXray(3e-5), 'M');
  assert.equal(classifyGoesXray(1.2e-4), 'X');
  assert.equal(classifyGoesXray(NaN), null);
});

test('parseEmWeather reads the real SWPC shapes and stays null-tolerant', () => {
  const em = parseEmWeather(SWPC_FIXTURES);
  assert.equal(em.solarWindKms, 452);
  assert.equal(em.bzGsm, -2.5);
  assert.equal(em.kp, 2);
  assert.equal(em.estimatedKp, 1.67);
  assert.equal(em.sfi, 101);
  assert.equal(em.xrayClass, 'B');
  assert.equal(em.xraySubclass, 'B4.6');
  const partial = parseEmWeather({ kpRows: SWPC_FIXTURES.kpRows });
  assert.equal(partial.kp, 2);
  assert.equal(partial.solarWindKms, null);
  assert.equal(partial.xrayClass, null);
  const empty = parseEmWeather({});
  assert.equal(empty.kp, null);
});

// ---------------------------------------------------------------------------
// MUF intuition — sanity bounds, never presented as measurement
// ---------------------------------------------------------------------------

const QUIET_EM = { solarWindKms: 380, kp: 1, xrayClass: 'B', sfi: 120, bzGsm: 2 };

test('estimateMuf is clamped to sane bounds and labelled intuition', () => {
  for (const em of [
    QUIET_EM,
    { ...QUIET_EM, kp: 9, xrayClass: 'X', sfi: 300 },
    { ...QUIET_EM, kp: 0, sfi: 65 },
    {},
  ]) {
    for (const dayFactor of [0, 0.5, 1]) {
      const { mufMHz, basis } = estimateMuf(em, { dayFactor });
      assert.ok(mufMHz >= 3 && mufMHz <= 60, `MUF out of bounds: ${mufMHz}`);
      assert.equal(basis, 'intuition');
    }
  }
});

test('estimateMuf responds to the physics in the right direction', () => {
  const day = estimateMuf(QUIET_EM, { dayFactor: 1 }).mufMHz;
  const night = estimateMuf(QUIET_EM, { dayFactor: 0 }).mufMHz;
  assert.ok(day > night, 'daytime MUF should exceed nighttime');
  const storm = estimateMuf({ ...QUIET_EM, kp: 8 }, { dayFactor: 0.5 }).mufMHz;
  const calm = estimateMuf({ ...QUIET_EM, kp: 1 }, { dayFactor: 0.5 }).mufMHz;
  assert.ok(storm < calm, 'geomagnetic storm should depress MUF');
  const flare = estimateMuf({ ...QUIET_EM, xrayClass: 'X' }, { dayFactor: 1 }).mufMHz;
  assert.ok(flare < day, 'day-side X flare should depress MUF');
  assert.equal(estimateMuf({ ...QUIET_EM, xrayClass: 'X' }, { dayFactor: 1 }).flaring, true);
});

test('bestBandsHint picks usable bands under the MUF intuition', () => {
  const hint = bestBandsHint(QUIET_EM, { dayFactor: 0.85 });
  assert.ok(hint.bands.length > 0);
  assert.equal(hint.basis, 'intuition');
  const night = bestBandsHint(QUIET_EM, { dayFactor: 0.1 });
  assert.ok(night.night && !hint.night);
  for (const band of [...hint.bands, ...night.bands]) {
    assert.ok(['160m','80m','60m','40m','30m','20m','17m','15m','12m','10m'].includes(band));
  }
});

test('bandsUnderMuf is monotone in MUF', () => {
  const low = bandsUnderMuf(7);
  const high = bandsUnderMuf(30);
  assert.ok(high.length >= low.length);
  assert.ok(low.every((b) => high.includes(b)));
});

test('emWeatherSummary tells the causal story with model labelling', () => {
  const lines = emWeatherSummary({ ...QUIET_EM, xraySubclass: 'B4.6', xrayClass: 'B' }, { dayFactor: 0.8 });
  const text = lines.join('\n');
  assert.match(text, /Solar wind 380/);
  assert.match(text, /Kp 1/);
  assert.match(text, /B4\.6/);
  assert.match(text, /Model, not measurement/);
});

// ---------------------------------------------------------------------------
// Source orchestration (injectable fetch)
// ---------------------------------------------------------------------------

test('createInvisibleOceanSource passes through the proxy snapshot', async () => {
  const payload = {
    spots: [],
    providers: { pskreporter: { count: 3 }, wsprnet: { count: 1 } },
    fetchedAt: 123,
    unavailable: false,
    reason: null,
  };
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push(String(url));
    return { ok: true, json: async () => payload };
  };
  const source = createInvisibleOceanSource({ fetchImpl, proxyBase: '/api/invisible-ocean' });
  const snap = await source.getPropagationSnapshot({});
  assert.deepEqual(snap.providers, payload.providers);
  assert.equal(snap.spots.length, 0);
  assert.ok(seen[0].includes('/api/invisible-ocean/spots'));
});

test('createInvisibleOceanSource parses the five SWPC feeds directly', async () => {
  const byUrl = (url) => {
    if (url.includes('solar-wind-speed')) return SWPC_FIXTURES.speedRows;
    if (url.includes('solar-wind-mag-field')) return SWPC_FIXTURES.magRows;
    if (url.includes('xrays')) return SWPC_FIXTURES.xrayRows;
    if (url.includes('k_index')) return SWPC_FIXTURES.kpRows;
    if (url.includes('10cm-flux')) return SWPC_FIXTURES.sfiRows;
    throw new Error(`unexpected ${url}`);
  };
  const fetchImpl = async (url) => ({ ok: true, json: async () => byUrl(String(url)) });
  const source = createInvisibleOceanSource({ fetchImpl });
  const em = await source.getEmWeatherSnapshot({});
  assert.equal(em.solarWindKms, 452);
  assert.equal(em.kp, 2);
  assert.equal(em.xrayClass, 'B');
});

test('createInvisibleOceanSource throws when every feed is down', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const source = createInvisibleOceanSource({ fetchImpl });
  await assert.rejects(() => source.getEmWeatherSnapshot({}), /SWPC unreachable/);
  await assert.rejects(() => source.getPropagationSnapshot({}), /HTTP 503/);
});

// ---------------------------------------------------------------------------
// Honesty copy
// ---------------------------------------------------------------------------

test('about copy states the boundaries', () => {
  assert.match(HONESTY_COPY.short, /never/i);
  assert.match(HONESTY_COPY.full, /never decode/i);
  assert.match(HONESTY_COPY.full, /resolution math does not close/i);
  assert.match(HONESTY_COPY.full, /MODEL, NOT MEASUREMENT/);
});
