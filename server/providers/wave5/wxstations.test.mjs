import assert from 'node:assert/strict';
import test from 'node:test';
import { wxstationsProxy, _wxstationsInternals } from './wxstations.js';

const {
  parseNwsObs,
  parseMetnoPoint,
  parseSmhi,
  parseHko,
  parseNea,
  parseIpma,
  parseImgw,
  parseEire,
  parseImo,
  sampleEvery,
} = _wxstationsInternals;

// — pure parsers —

test('parseNwsObs converts units and reads geometry', () => {
  const doc = {
    geometry: { coordinates: [-79.97, 37.32] },
    properties: {
      temperature: { value: 24 },
      windSpeed: { value: 36 }, // km/h
      windDirection: { value: 180 },
      barometricPressure: { value: 101049.84 }, // Pa
      relativeHumidity: { value: 33.6 },
      timestamp: '2026-09-27T19:25:00+00:00',
    },
  };
  const r = parseNwsObs(doc, 'KROA');
  assert.equal(r.source, 'nws');
  assert.equal(r.id, 'KROA');
  assert.equal(r.lat, 37.32);
  assert.equal(r.lon, -79.97);
  assert.equal(r.tempC, 24);
  assert.equal(r.windMs, 10); // 36 km/h = 10 m/s
  assert.equal(r.pressureHpa, 1010.4984);
  assert.equal(r.windDirDeg, 180);
  assert.ok(Number.isFinite(r.timeMs));
});

test('parseNwsObs tolerates null upstream values', () => {
  const r = parseNwsObs({
    geometry: { coordinates: [0, 0] },
    properties: { temperature: { value: null }, windSpeed: { value: null }, timestamp: 'x' },
  }, 'KXXX');
  assert.equal(r.tempC, null);
  assert.equal(r.windMs, null);
  assert.equal(r.timeMs, null);
});

test('parseMetnoPoint reads first timeseries instant, kind forecast', () => {
  const doc = {
    properties: {
      timeseries: [{
        time: '2026-09-27T19:00:00Z',
        data: { instant: { details: {
          air_temperature: 13.7, wind_speed: 3.0, wind_from_direction: 128,
          relative_humidity: 79.8, air_pressure_at_sea_level: 1021.9,
        } } },
      }],
    },
  };
  const r = parseMetnoPoint(doc, { slug: 'oslo', name: 'Oslo', lat: 59.9, lon: 10.7 });
  assert.equal(r.kind, 'forecast');
  assert.equal(r.tempC, 13.7);
  assert.equal(r.windMs, 3.0);
  assert.equal(r.pressureHpa, 1021.9);
  assert.equal(r.lat, 59.9);
});

test('parseSmhi samples deterministically and drops rows without coords/temp', () => {
  const doc = {
    station: Array.from({ length: 46 }, (_, i) => ({
      key: String(1000 + i),
      name: `S${i}`,
      latitude: 60 + i * 0.1,
      longitude: 15,
      value: [{ date: 1790535600000, value: String(10 + i), quality: 'G' }],
    })),
  };
  const rows = parseSmhi(doc, { every: 23, cap: 12 });
  assert.equal(rows.length, 2); // indices 0 and 23
  assert.equal(rows[0].id, 'smhi-1000');
  assert.equal(rows[1].id, 'smhi-1023');
  assert.ok(rows.every((r) => r.source === 'smhi' && r.coordApprox === false));
});

test('parseHko filters places and marks coordApprox', () => {
  const doc = {
    updateTime: '2026-09-28T03:02:00+08:00',
    temperature: { data: [
      { place: "Hong Kong Observatory", value: 29, unit: 'C' },
      { place: "King's Park", value: 28, unit: 'C' },
      { place: 'Somewhere Else', value: 20, unit: 'C' },
    ] },
    humidity: { data: [{ place: 'Hong Kong Observatory', value: 81, unit: 'percent' }] },
  };
  const rows = parseHko(doc, {
    places: ['Hong Kong Observatory', "King's Park"], lat: 22.32, lon: 114.17,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tempC, 29);
  assert.equal(rows[0].rhPct, 81);
  assert.equal(rows[1].rhPct, null);
  assert.ok(rows.every((r) => r.coordApprox === true));
});

test('parseNea joins readings with station metadata coords', () => {
  const doc = {
    metadata: { stations: [
      { id: 'S109', name: 'Ang Mo Kio Avenue 5', location: { latitude: 1.3793, longitude: 103.85 } },
    ] },
    items: [{ timestamp: '2026-09-28T03:35:00+08:00', readings: [{ station_id: 'S109', value: 25.7 }] }],
  };
  const rows = parseNea(doc);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lat, 1.3793);
  assert.equal(rows[0].tempC, 25.7);
});

test('parseIpma yields station-index rows with null temps', () => {
  const doc = [
    { geometry: { coordinates: [-7.821, 37.033] }, properties: { idEstacao: 1210881, localEstacao: 'Olhão, EPPO' } },
  ];
  const rows = parseIpma(doc, { every: 1, cap: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'station-index');
  assert.equal(rows[0].tempC, null);
  assert.equal(rows[0].lat, 37.033);
  assert.equal(rows[0].lon, -7.821);
});

test('parseImgw handles Polish decimal strings and hour-only time', () => {
  const doc = [{
    id_stacji: '12295', stacja: 'Białystok', data_pomiaru: '2026-09-27', godzina_pomiaru: '19',
    temperatura: '9.1', predkosc_wiatru: '0', kierunek_wiatru: '0',
    wilgotnosc_wzgledna: '98.0', suma_opadu: '0.01', cisnienie: '1030',
  }];
  const rows = parseImgw(doc, { every: 1, cap: 5, lat: 51.92, lon: 19.15 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tempC, 9.1);
  assert.equal(rows[0].pressureHpa, 1030);
  assert.equal(rows[0].coordApprox, true);
  assert.equal(rows[0].timeMs, Date.parse('2026-09-27T19:00:00Z'));
});

test('parseEire converts km/h wind and tolerates padded strings', () => {
  const doc = [{
    name: 'Athenry', temperature: '14', windSpeed: '9', windDirection: 180,
    humidity: ' 87 ', pressure: '1012',
  }];
  const r = parseEire(doc, { lat: 53.3, lon: -8.75 });
  assert.equal(r.tempC, 14);
  assert.equal(r.windMs, 2.5); // 9 km/h
  assert.equal(r.rhPct, 87);
  assert.equal(r.coordApprox, true);
});

test('parseImo regex-parses the XML station block', () => {
  const xml = '<observations><station id="1" valid="1"><name>Reykjavík</name>' +
    '<time>2026-09-27 19:00:00</time><F>1</F><D>NNW</D><FX>3</FX><FG>4</FG>' +
    '<T>8.0</T><W></W><V></V><R>0.0</R></station></observations>';
  const r = parseImo(xml, { lat: 64.15, lon: -21.94 });
  assert.equal(r.tempC, 8.0);
  assert.equal(r.windMs, 3);
  assert.equal(r.coordApprox, true);
  assert.ok(Number.isFinite(r.timeMs));
});

test('parseImo returns null on unparseable XML', () => {
  assert.equal(parseImo('<nope/>', { lat: 0, lon: 0 }), null);
});

// — proxy handler with stubbed fetch —

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { chunks.push(body); res.body = chunks.join(''); },
    once() {}, removeListener() {},
  };
  return res;
}

function jsonResponse(obj, status = 200) {
  const text = JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    body: null,
  };
}

function nwsObs(temp = 20) {
  return {
    geometry: { coordinates: [-80, 37] },
    properties: {
      temperature: { value: temp }, windSpeed: { value: 18 }, windDirection: { value: 90 },
      barometricPressure: { value: 100000 }, relativeHumidity: { value: 50 },
      timestamp: '2026-09-27T19:00:00+00:00',
    },
  };
}

function stubFetch(map) {
  return async (url) => {
    for (const [prefix, responder] of map) {
      if (url.startsWith(prefix)) return responder(url);
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test('handler sweeps all sources and reports per-source status', async () => {
  const map = [
    ['https://api.weather.gov/stations/', (url) => {
      const sid = url.split('/stations/')[1].split('/')[0];
      return jsonResponse(nwsObs(sid === 'KROA' ? 24 : 20));
    }],
    ['https://api.met.no/', () => jsonResponse({
      properties: { timeseries: [{ time: '2026-09-27T19:00:00Z',
        data: { instant: { details: { air_temperature: 12, wind_speed: 2, wind_from_direction: 100,
          relative_humidity: 70, air_pressure_at_sea_level: 1015 } } } }] },
    })],
    ['https://opendata-download-metobs.smhi.se/', () => jsonResponse({
      station: [{ key: '1', name: 'A', latitude: 60, longitude: 15,
        value: [{ date: 1, value: '5.0', quality: 'G' }] }],
    })],
    ['https://data.weather.gov.hk/', () => { throw new Error('boom'); }],
    ['https://api.data.gov.sg/', () => jsonResponse({
      metadata: { stations: [{ id: 'S1', name: 'X', location: { latitude: 1.3, longitude: 103.8 } }] },
      items: [{ timestamp: '2026-09-28T00:00:00+08:00', readings: [{ station_id: 'S1', value: 27 }] }],
    })],
    ['https://api.ipma.pt/', () => jsonResponse([
      { geometry: { coordinates: [-8, 37.5] }, properties: { idEstacao: 1, localEstacao: 'L' } },
    ])],
    ['https://danepubliczne.imgw.pl/', () => jsonResponse([
      { id_stacji: '1', stacja: 'W', data_pomiaru: '2026-09-27', godzina_pomiaru: '19',
        temperatura: '10', predkosc_wiatru: '2', kierunek_wiatru: '90',
        wilgotnosc_wzgledna: '80', cisnienie: '1010' },
    ])],
    ['https://prodapi.metweb.ie/', () => jsonResponse([
      { name: 'Athenry', temperature: '14', windSpeed: '9', windDirection: 180, humidity: '87', pressure: '1012' },
    ])],
    ['https://xmlweather.vedur.is/', () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => '<observations><station id="1"><name>Reykjavík</name>' +
        '<time>2026-09-27 19:00:00</time><F>1</F><D>N</D><FX>3</FX><FG>4</FG><T>8.0</T>' +
        '<W></W><V></V><R>0.0</R></station></observations>',
      body: null,
    })],
  ];
  const provider = wxstationsProxy({ fetchImpl: stubFetch(map), now: () => 1_759_000_000_000 });
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  assert.deepEqual(calls.map((c) => c.route), ['/api/wxstations', '/api/wxstations']);

  const req = { method: 'GET', url: '/api/wxstations' };
  const res = fakeRes();
  await calls[0].handler(req, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.count, body.stations.length);
  assert.ok(body.count >= 4 + 3 + 1 + 1 + 1 + 1 + 1); // nws4 metno3 smhi1 nea1 ipma1 imgw1 eire1 imo1 (hko stubbed to fail)
  const hko = body.sources.find((s) => s.id === 'hko');
  assert.equal(hko.status, 'error');
  assert.equal(body.unavailable, false);
  const kroa = body.stations.find((s) => s.id === 'KROA');
  assert.equal(kroa.tempC, 24);
  const kinds = new Set(body.stations.map((s) => s.kind));
  assert.ok(kinds.has('forecast'));
  assert.ok(kinds.has('station-index'));
});

test('handler serves honest empty payload when everything fails', async () => {
  const provider = wxstationsProxy({
    fetchImpl: async () => { throw new Error('down'); },
    now: () => 1_759_000_000_000,
  });
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/wxstations' }, res);
  const body = JSON.parse(res.body);
  assert.equal(body.unavailable, true);
  assert.equal(body.count, 0);
  assert.ok(body.sources.every((s) => s.status === 'error'));
});

test('handler rejects non-GET', async () => {
  const provider = wxstationsProxy({ fetchImpl: async () => { throw new Error('x'); } });
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  const res = fakeRes();
  await calls[0].handler({ method: 'POST', url: '/api/wxstations' }, res);
  assert.equal(res.statusCode, 405);
});

test('sampleEvery is deterministic', () => {
  const a = Array.from({ length: 100 }, (_, i) => i);
  assert.deepEqual(sampleEvery(a, 7, 5), sampleEvery(a, 7, 5));
  assert.deepEqual(sampleEvery(a, 7, 5), [0, 7, 14, 21, 28]);
});
