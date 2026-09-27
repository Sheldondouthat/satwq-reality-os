import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "model": true,
  "modelName": "CAMS (Copernicus Atmosphere Monitoring Service) via Open-Meteo",
  "location": {
    "requested": {
      "lat": 37.267,
      "lon": -80.727
    }
  },
  "current": {
    "usAqi": 32,
    "pm2_5": 7.4
  }
};

test('aqModel: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/aq-model');
});

test('aqModel: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('aqModel: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /AQI 32/);
});

test('aqModel: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /MODEL @ 37\.267/);
});

test('aqModel: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
