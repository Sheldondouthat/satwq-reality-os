import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCdecCsv,
  parseNwisIv,
  classifyFloodBand,
  reservoirState,
  waterTwinProxy,
} from './waterTwin.js';

test('parseCdecCsv: keeps only sensor-15 STORAGE rows, latest per station (verified 2026-09-27)', () => {
  const csv =
    'STATION_ID,DURATION,SENSOR_NUMBER,SENSOR_TYPE,DATE TIME,OBS DATE,VALUE,DATA_FLAG,UNITS\n' +
    'SHA,D,15,STORAGE,20260924 0000,20260925 0000,2482511, ,AF\n' +
    'SHA,D,15,STORAGE,20260925 0000,20260926 0000,2477120, ,AF\n' +
    'SHA,D,15,STORAGE,20260926 0000,20260926 0000,---, ,AF\n' +
    'SHA,D,2,EVAPORATION,20260925 0000,20260926 0000,100, ,AF\n' +
    'ORO,D,15,STORAGE,20260925 0000,20260926 0000,1234567, ,AF\n';
  const out = parseCdecCsv(csv);
  assert.equal(out.SHA.storageAf, 2477120);
  assert.equal(out.SHA.dateTime, '20260925 0000');
  assert.equal(out.ORO.storageAf, 1234567);
});

test('parseCdecCsv: empty text returns empty object', () => {
  assert.deepEqual(parseCdecCsv(''), {});
});

test('parseNwisIv: collapses 00060/00065 series per site (verified 2026-09-27 shape)', () => {
  const payload = {
    value: {
      timeSeries: [
        {
          sourceInfo: { siteCode: [{ value: '07010000' }] },
          variable: { variableCode: [{ value: '00060' }] },
          values: [{ value: [{ value: '273000', dateTime: '2026-09-27T00:00:00.000-05:00' }] }],
        },
        {
          sourceInfo: { siteCode: [{ value: '07010000' }] },
          variable: { variableCode: [{ value: '00065' }] },
          values: [{ value: [{ value: '16.09', dateTime: '2026-09-27T00:00:00.000-05:00' }] }],
        },
        {
          sourceInfo: { siteCode: [{ value: '07010000' }] },
          variable: { variableCode: [{ value: '00010' }] },
          values: [{ value: [{ value: '70', dateTime: 'x' }] }],
        },
      ],
    },
  };
  const out = parseNwisIv(payload);
  assert.equal(out['07010000'].flowCfs, 273000);
  assert.equal(out['07010000'].gageFt, 16.09);
});

test('parseNwisIv: malformed payload returns empty', () => {
  assert.deepEqual(parseNwisIv({}), {});
  assert.deepEqual(parseNwisIv(null), {});
});

test('classifyFloodBand: bands from curated reference stages', () => {
  assert.equal(classifyFloodBand(30, 30, 27), 'minor-flood');
  assert.equal(classifyFloodBand(33, 30, 27), 'moderate-flood');
  assert.equal(classifyFloodBand(37, 30, 27), 'major-flood');
  assert.equal(classifyFloodBand(28, 30, 27), 'action');
  assert.equal(classifyFloodBand(20, 30, 27), 'normal');
  assert.equal(classifyFloodBand(NaN, 30, 27), 'unknown');
});

test('reservoirState: pct with one decimal, null on bad input', () => {
  assert.equal(reservoirState(2477120, 4552000), 54.4);
  assert.equal(reservoirState(null, 4552000), null);
  assert.equal(reservoirState(100, 0), null);
});

function fakeReqRes(url = '/api/water-twin') {
  const req = { method: 'GET', url, headers: {}, on: () => {}, removeListener: () => {} };
  const chunks = [];
  const res = {
    statusCode: null,
    writeHead(status) { this.statusCode = status; },
    end(body) { chunks.push(body); },
    once: () => {},
    removeListener: () => {},
  };
  return { req, res, body: () => JSON.parse(chunks.join('')) };
}

test('handler: end-to-end with stubbed CDEC + NWIS', async () => {
  const cdec =
    'STATION_ID,DURATION,SENSOR_NUMBER,SENSOR_TYPE,DATE TIME,OBS DATE,VALUE,DATA_FLAG,UNITS\n' +
    'SHA,D,15,STORAGE,20260925 0000,20260926 0000,2477120, ,AF\n';
  const nwis = JSON.stringify({
    value: {
      timeSeries: [
        {
          sourceInfo: { siteCode: [{ value: '07010000' }] },
          variable: { variableCode: [{ value: '00065' }] },
          values: [{ value: [{ value: '16.09', dateTime: '2026-09-27T00:00:00.000-05:00' }] }],
        },
      ],
    },
  });
  const fetchImpl = async (url) => {
    const text = String(url).includes('cdec.water.ca.gov') ? cdec : nwis;
    return { ok: true, text: async () => text, body: { cancel: async () => {} } };
  };
  const proxy = waterTwinProxy({ fetchImpl, now: () => 1758950400000 });
  const { req, res, body } = fakeReqRes();
  await new Promise((resolve) => {
    const origEnd = res.end.bind(res);
    res.end = (b) => { origEnd(b); resolve(); };
    proxy.configureServer({ middlewares: { use: (route, handler) => handler(req, res) } });
  });
  const payload = body();
  assert.equal(res.statusCode, 200);
  assert.equal(payload.schemaVersion, 1);
  const shasta = payload.reservoirs.find((r) => r.id === 'SHA');
  assert.equal(shasta.status, 'live');
  assert.equal(shasta.storageAf, 2477120);
  assert.equal(shasta.pctFull, 54.4);
  const stl = payload.rivers.find((r) => r.site === '07010000');
  assert.equal(stl.status, 'live');
  assert.equal(stl.gageFt, 16.09);
  assert.equal(stl.band, 'normal');
});

test('handler: total upstream failure degrades to unavailable (not a throw)', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const proxy = waterTwinProxy({ fetchImpl, now: () => 1758950400000 });
  const { req, res, body } = fakeReqRes();
  await new Promise((resolve) => {
    const origEnd = res.end.bind(res);
    res.end = (b) => { origEnd(b); resolve(); };
    proxy.configureServer({ middlewares: { use: (route, handler) => handler(req, res) } });
  });
  const payload = body();
  assert.equal(res.statusCode, 200);
  assert.equal(payload.unavailable, true);
  assert.ok(payload.reservoirs.every((r) => r.status === 'unavailable'));
  assert.ok(payload.rivers.every((r) => r.status === 'unavailable'));
  assert.equal(payload.sourceErrors.cdec, 'network down');
  assert.equal(payload.sourceErrors.nwis, 'network down');
});
