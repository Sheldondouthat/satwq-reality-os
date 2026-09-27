import assert from 'node:assert/strict';
import test from 'node:test';
import { stationsExtProxy, _stationsExtInternals } from './stationsExt.js';

const { parseHydrometricCsv, parseCitypageXml, parseFmiWfs, parseDwdRecentDir, buildSnapshot } = _stationsExtInternals;

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

const HYDRO_CSV = `ID,Name / Nom,Latitude,Longitude,Prov/Terr,Timezone / Fuseau horaire
01AD003,"ST. FRANCIS RIVER AT OUTLET OF GLASIER LAKE",47.206580,-68.955550,NB,UTC-04:00
badline without enough fields
01AF002,"SAINT JOHN RIVER AT GRAND FALLS",47.038890,-67.739720,NB,UTC-04:00
`;

const CITYPAGE_XML = `<?xml version="1.0"?>
<siteData xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<location><continent>North America</continent><country code="ca">Canada</country><province code="on">Ontario</province>
<name code="s0000422">Toronto (Pearson)</name><latitude>43.68</latitude><longitude>-79.63</longitude></location>
<warnings/><currentConditions>
<station code="yyz" lat="43.68" lon="-79.63"/>
<dateTime name="observation" zone="UTC" UTCOffset="0"><timeStamp>20260927160000</timeStamp></dateTime>
<condition>Partly Cloudy</condition><temperature>14.2</temperature>
<relativeHumidity>63</relativeHumidity><pressure>101.4</pressure>
<wind><speed>18</speed><direction>SW</direction></wind>
</currentConditions></siteData>`;

const FMI_XML = `<?xml version="1.0"?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:BsWfs="http://xml.fmi.fi/schema/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2">
<wfs:member><BsWfs:BsWfsElement gml:id="BsWfsElement.1.1.1">
<BsWfs:Location><gml:Point><gml:pos>60.17 24.94</gml:pos></gml:Point></BsWfs:Location>
<BsWfs:Time><gml:TimeInstant><gml:timePosition>2026-09-27T16:00:00Z</gml:timePosition></gml:TimeInstant></BsWfs:Time>
<BsWfs:ParameterName>t2m</BsWfs:ParameterName><BsWfs:ParameterValue>12.3</BsWfs:ParameterValue>
</BsWfs:BsWfsElement></wfs:member>
<wfs:member><BsWfs:BsWfsElement gml:id="BsWfsElement.1.1.2">
<BsWfs:Location><gml:Point><gml:pos>60.17 24.94</gml:pos></gml:Point></BsWfs:Location>
<BsWfs:Time><gml:TimeInstant><gml:timePosition>2026-09-27T16:00:00Z</gml:timePosition></gml:TimeInstant></BsWfs:Time>
<BsWfs:ParameterName>ws_10min</BsWfs:ParameterName><BsWfs:ParameterValue>4.1</BsWfs:ParameterValue>
</BsWfs:BsWfsElement></wfs:member>
</wfs:FeatureCollection>`;

const DWD_DIR = `<html><head><title>Index of /recent/</title></head><body><pre>
<a href="tageswerte_KL_00011_akt.zip">tageswerte_KL_00011_akt.zip</a>  27-Sep-2026 08:55:07  10702
<a href="tageswerte_KL_00044_akt.zip">tageswerte_KL_00044_akt.zip</a>  27-Sep-2026 08:55:07  34530
</pre></body></html>`;

test('stationsExtProxy mounts /api/stations-ext on both server shapes', () => {
  const routes = mount(stationsExtProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/stations-ext', '/api/stations-ext']);
});

test('parseHydrometricCsv skips header and malformed lines', () => {
  const out = parseHydrometricCsv(HYDRO_CSV);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'ec-hydro:01AD003');
  assert.equal(out[0].name, 'ST. FRANCIS RIVER AT OUTLET OF GLASIER LAKE');
  assert.equal(out[0].lat, 47.2066);
  assert.equal(out[0].lon, -68.9555); // float repr: -68.95555*10000 = 689555.4999… → rounds to -68.9555
  assert.equal(out[0].network, 'EC-HYDRO-NB');
  assert.equal(out[0].obs, null);
});

test('parseCitypageXml extracts location and current conditions', () => {
  const out = parseCitypageXml(CITYPAGE_XML, '20260927T160027.000Z_MSC_CitypageWeather_s0000422_en.xml');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'ec-citypage:s0000422');
  assert.equal(out[0].name, 'Toronto (Pearson)');
  assert.equal(out[0].lat, 43.68);
  assert.equal(out[0].obs.tempC, 14.2);
  assert.equal(out[0].obs.condition, 'Partly Cloudy');
  assert.equal(out[0].obs.humidityPct, 63);
  assert.equal(out[0].obs.pressureKpa, 101.4);
  assert.equal(out[0].obs.observedAt, '2026-09-27T16:00:00Z');
});

test('parseFmiWfs groups elements by rounded station position', () => {
  const out = parseFmiWfs(FMI_XML);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'fmi:60.17,24.94');
  assert.equal(out[0].lat, 60.17);
  assert.equal(out[0].network, 'FMI-WFS');
  assert.equal(out[0].obs.t2m, 12.3);
  assert.equal(out[0].obs.ws_10min, 4.1);
  assert.equal(out[0].obs.observedAt, '2026-09-27T16:00:00Z');
});

test('parseDwdRecentDir extracts reporting station IDs', () => {
  const out = parseDwdRecentDir(DWD_DIR);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'dwd:00011');
  assert.equal(out[0].network, 'DWD-CLI');
  assert.equal(out[0].lat, null); // dir listing carries no coordinates — honest null
  assert.match(out[0].obs.reportingFile, /tageswerte_KL_00011_akt\.zip/);
});

test('buildSnapshot sorts stations with obs first and records per-source status', () => {
  const hydro = parseHydrometricCsv(HYDRO_CSV);
  const city = parseCitypageXml(CITYPAGE_XML, 'x_s0000422_en.xml');
  const payload = buildSnapshot([
    { key: 'ec_hydrometric', ok: true, count: hydro.length, attribution: 'EC', latencyMs: 5, stations: hydro },
    { key: 'ec_citypage', ok: true, count: city.length, attribution: 'EC', latencyMs: 7, stations: city },
    { key: 'fmi', ok: false, count: 0, attribution: 'FMI', latencyMs: 3, error: 'timeout', stations: [] },
  ]);
  assert.equal(payload.stationCount, 3);
  assert.equal(payload.stations[0].id, 'ec-citypage:s0000422'); // obs-first sort
  assert.equal(payload.sources.fmi.ok, false);
  assert.equal(payload.sources.fmi.error, 'timeout');
});

test('handler returns 502 JSON when every source fails', async () => {
  _stationsExtInternals.clearCaches();
  const calls = mount(stationsExtProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/stations-ext'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /stations_ext_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(stationsExtProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/stations-ext', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
