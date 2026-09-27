import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INFRASOUND_ROUTE,
  envelopePa,
  infrasoundProxy,
  parseStationText,
  pressureState,
} from './infrasound.js';

// Real AV.AU22..BDF record 0 reused as the mocked dataselect payload.
const RECORD0_HEX = '323431383332442041553232202020424446415607ea010d0c0000000000000d0032000100000002000000000040003003e800380b01090003e900005a00000002aaa00000008d4b00004d8a80007b6cbd2ff905bb987588ba0d736cbb45796dbf748496400009bb000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

const STATION_TEXT =
  '#Network | Station | Location | Channel | Latitude | Longitude | Elevation | Depth | Azimuth | Dip | ' +
  'SensorDescription | Scale | ScaleFreq | ScaleUnits | SampleRate | StartTime | EndTime\n' +
  'AV|AU22||BDF|59.37058|-153.35498|105.0|0.0|0.0|0.0|Pressure|7999.999886041432|1.0|Pa|50.0|' +
  '2023-05-24T21:54:00.0000|\n';

test('parseStationText extracts coords and counts-per-Pa scale', () => {
  const meta = parseStationText(STATION_TEXT, 'AU22');
  assert.ok(meta);
  assert.equal(meta.lat, 59.37058);
  assert.equal(meta.lon, -153.35498);
  assert.ok(Math.abs(meta.scale - 8000) < 0.001, `scale=${meta.scale}`);
});

test('parseStationText returns null for a non-BDF row', () => {
  const other = STATION_TEXT.replace('|BDF|', '|BHZ|');
  assert.equal(parseStationText(other, 'AU22'), null);
});

test('envelopePa peak-holds bins and normalizes by scale', () => {
  const samples = Int32Array.from([0, 8000, -4000, 2000, -1000, 500, -250, 125]);
  const env = envelopePa(samples, 8000, 4);
  assert.equal(env.length, 4);
  // bin 0 covers samples 0..1 → peak |8000|/8000 = 1
  assert.equal(env[0], 1);
  assert.ok(env.every((v) => v >= 0 && v <= 1));
});

test('pressureState thresholds are labeled heuristics', () => {
  assert.equal(pressureState(0.05), 'quiet');
  assert.equal(pressureState(0.5), 'active');
  assert.equal(pressureState(5), 'elevated');
  assert.equal(pressureState(50), 'loud');
  assert.equal(pressureState(NaN), 'unknown');
});

test('infrasoundProxy decodes a mocked miniSEED window end-to-end', async () => {
  const mseed = Buffer.from(RECORD0_HEX, 'hex');
  const fetchImpl = async (url) => {
    if (String(url).includes('station')) {
      return { ok: true, status: 200, text: async () => STATION_TEXT };
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => mseed.buffer.slice(mseed.byteOffset, mseed.byteOffset + mseed.byteLength),
    };
  };
  const proxy = infrasoundProxy({ fetchImpl, ttlMs: 60_000, timeoutMs: 10_000 });
  let captured;
  const res = {
    headersSent: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { captured = { status: this.status, body: JSON.parse(body) }; },
  };
  await new Promise((resolve) => {
    proxy.configureServer({ middlewares: { use(route, handler) {
      assert.equal(route, INFRASOUND_ROUTE);
      resolve(handler({ method: 'GET' }, res));
    } } });
  });
  assert.equal(captured.status, 200);
  const au22 = captured.body.stations.find((s) => s.sta === 'AU22');
  assert.ok(au22, 'AU22 present');
  assert.equal(au22.state, 'live');
  assert.equal(au22.lat, 59.37058);
  assert.equal(au22.nSamples, 13);
  // 13 samples of the fixture: rms ≈ 25789 counts / 8000 ≈ 3.22 Pa
  assert.ok(Number.isFinite(au22.rmsPa) && au22.rmsPa > 1 && au22.rmsPa < 10, `rmsPa=${au22.rmsPa}`);
  assert.ok(Array.isArray(au22.envelopePa) && au22.envelopePa.length === 120);
  assert.ok(captured.body.honesty.includes('counts'), 'honesty note present');
});

test('infrasoundProxy degrades softly when upstream is down', async () => {
  const fetchImpl = async () => { throw new Error('boom'); };
  const proxy = infrasoundProxy({ fetchImpl, ttlMs: 60_000, timeoutMs: 5_000 });
  let captured;
  const res = {
    headersSent: false,
    writeHead(status) { this.status = status; },
    end(body) { captured = { status: this.status, body: JSON.parse(body) }; },
  };
  await new Promise((resolve) => {
    proxy.configureServer({ middlewares: { use(route, handler) {
      resolve(handler({ method: 'GET' }, res));
    } } });
  });
  // soft degrade: 200 with per-station error states, never a bare 500
  assert.equal(captured.status, 200);
  assert.ok(captured.body.stations.length > 0);
  assert.ok(captured.body.stations.every((s) => s.state === 'error'));
});
