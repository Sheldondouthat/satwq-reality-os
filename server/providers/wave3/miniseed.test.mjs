import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeMiniseed,
  rmsPeak,
} from './miniseed.js';

// Real AV.AU22..BDF record 0 (2026-09-26T12:00:00Z, Steim-2, nsamp=13).
// Captured live from EarthScope dataselect; the first 512 bytes of the
// verified payload. Regression guard for the Steim-2 decoder.
const RECORD0_HEX = '323431383332442041553232202020424446415607ea010d0c0000000000000d0032000100000002000000000040003003e800380b01090003e900005a00000002aaa00000008d4b00004d8a80007b6cbd2ff905bb987588ba0d736cbb45796dbf748496400009bb000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
const RECORD0_SAMPLES = [36171,34999,33558,31771,29515,26835,23789,20569,18147,16464,16185,17359,19850];

const record0 = () => Buffer.from(RECORD0_HEX, 'hex');

test('fixed header reads the AU22 record identity', () => {
  const [rec] = decodeMiniseed(record0());
  const h = rec.header;
  assert.equal(h.station, 'AU22');
  assert.equal(h.network, 'AV');
  assert.equal(h.channel, 'BDF');
  assert.equal(h.encoding, 11); // Steim-2
  assert.equal(h.nsamp, 13);
  assert.equal(h.sampleRateHz, 50);
  const d = new Date(h.startMs).toISOString();
  assert.ok(d.startsWith('2026-09-26T12:00:00'), d);
});

test('Steim-2 decode reproduces the exact sample vector', () => {
  const [rec] = decodeMiniseed(record0());
  assert.equal(rec.samples.length, 13);
  assert.deepEqual(Array.from(rec.samples), RECORD0_SAMPLES);
});

test('integration constants match first/last samples (libmseed rule)', () => {
  const [rec] = decodeMiniseed(record0());
  assert.equal(rec.x0, RECORD0_SAMPLES[0]);
  assert.equal(rec.xn, RECORD0_SAMPLES[RECORD0_SAMPLES.length - 1]);
});

test('samples are physically plausible infrasound (no explosion)', () => {
  const [rec] = decodeMiniseed(record0());
  const { rms, peak } = rmsPeak(rec.samples);
  assert.ok(rms < 1e7, `rms ${rms} exploded`);
  assert.ok(peak < 1e8, `peak ${peak} exploded`);
  let maxJump = 0;
  for (let i = 1; i < rec.samples.length; i++) {
    maxJump = Math.max(maxJump, Math.abs(rec.samples[i] - rec.samples[i - 1]));
  }
  assert.ok(maxJump < 1e6, `intra-record jump ${maxJump} exploded`);
});

test('decodeMiniseed rejects empty and non-record buffers', () => {
  assert.throws(() => decodeMiniseed(Buffer.alloc(0)), /too small/);
  assert.throws(() => decodeMiniseed(Buffer.alloc(100)), /implausible year/);
});

test('parseFixedHeader rejects implausible years', () => {
  const buf = record0();
  // corrupt year field (bytes 20-21) to 1900
  buf[20] = 0x07; buf[21] = 0x6c;
  assert.throws(() => decodeMiniseed(buf), /implausible year/);
  // corrupt blockette-1000 encoding field (index 52; blkOff=48) to unsupported
  const buf2 = record0();
  buf2[52] = 0x99;
  assert.throws(() => decodeMiniseed(buf2), /unsupported encoding/);
});
