import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  P_WAVE_KM_S,
  S_WAVE_KM_S,
  WAVEFRONT_TTL_MS,
  EARTH_HALF_CIRCUMFERENCE_KM,
  WAVEFRONT_QUAKE_LIMIT,
  wavefrontRadii,
  isWavefrontExpired,
  wavefrontAlpha,
  normalizeQuakeFeature,
  pickSignificantQuakes,
} from './model.js';
import { createUsgsWavefrontSource } from './source.js';

// Frozen clock: 2026-09-27T12:00:00Z.
const NOW = Date.parse('2026-09-27T12:00:00Z');

function feature({ id = 'q1', lon = -122.0, lat = 37.0, mag = 5.2, time = NOW - 60000, place = 'Test' } = {}) {
  return {
    id,
    geometry: { type: 'Point', coordinates: [lon, lat, 10] },
    properties: { mag, time, place, url: 'https://example.test/q1' },
  };
}

describe('seismicWaves model: wavefront math vs origin time', () => {
  it('grows P at ~8 km/s and S at ~4.5 km/s from the origin epoch', () => {
    const r = wavefrontRadii(NOW - 60000, NOW); // 60 s old
    assert.equal(r.ageSec, 60);
    assert.ok(Math.abs(r.pKm - 60 * P_WAVE_KM_S) < 1e-9);
    assert.ok(Math.abs(r.sKm - 60 * S_WAVE_KM_S) < 1e-9);
    assert.equal(r.expired, false);
  });

  it('clamps radii at half Earth circumference and flags old quakes expired', () => {
    const r = wavefrontRadii(NOW - 3600_000, NOW); // 1 h old
    assert.equal(r.pKm, EARTH_HALF_CIRCUMFERENCE_KM); // 28,800 km -> clamped
    assert.equal(r.sKm, 3600 * S_WAVE_KM_S); // 16,200 km — below the cap, unclamped
    assert.equal(r.expired, true);
  });

  it('treats future origin times as age zero', () => {
    const r = wavefrontRadii(NOW + 5000, NOW);
    assert.equal(r.ageSec, 0);
    assert.equal(r.pKm, 0);
    assert.equal(r.expired, false);
  });

  it('expires rings older than the 30-minute TTL', () => {
    assert.equal(isWavefrontExpired(NOW - 29 * 60000, NOW), false);
    assert.equal(isWavefrontExpired(NOW - 31 * 60000, NOW), true);
    assert.equal(isWavefrontExpired(NOW - WAVEFRONT_TTL_MS, NOW), false); // boundary
    assert.equal(isWavefrontExpired(NaN, NOW), true);
  });

  it('fades ring alpha linearly from fresh to TTL', () => {
    assert.equal(wavefrontAlpha(0), 0.95);
    assert.ok(Math.abs(wavefrontAlpha(900) - (0.95 + 0.06) / 2) < 1e-9);
    assert.ok(Math.abs(wavefrontAlpha(1800) - 0.06) < 1e-9); // float-exact, not bit-exact
    assert.ok(Math.abs(wavefrontAlpha(99999) - 0.06) < 1e-9); // clamped past TTL
    assert.equal(wavefrontAlpha(-5), 0.95); // clamped before t=0
  });

  it('rejects non-finite clocks', () => {
    assert.throws(() => wavefrontRadii(NaN, NOW), TypeError);
    assert.throws(() => wavefrontRadii(NOW, Infinity), TypeError);
  });
});

describe('seismicWaves model: quake selection', () => {
  it('normalizes USGS features and rejects broken ones', () => {
    const q = normalizeQuakeFeature(feature());
    assert.equal(q.id, 'q1');
    assert.equal(q.lon, -122.0);
    assert.equal(q.lat, 37.0);
    assert.equal(q.mag, 5.2);
    assert.equal(q.originTimeMs, NOW - 60000);
    assert.equal(q.place, 'Test');
    assert.equal(normalizeQuakeFeature(null), null);
    assert.equal(normalizeQuakeFeature({ properties: {} }), null);
    assert.equal(
      normalizeQuakeFeature(feature({ mag: NaN })),
      null,
    );
  });

  it('picks the N most recent mag>=4.5 quakes, newest first', () => {
    const rows = [
      { id: 'old', mag: 7.0, originTimeMs: NOW - 500000, lon: 0, lat: 0 },
      { id: 'new', mag: 5.0, originTimeMs: NOW - 10000, lon: 1, lat: 1 },
      { id: 'small', mag: 4.4, originTimeMs: NOW - 5000, lon: 2, lat: 2 },
      { id: 'mid', mag: 6.1, originTimeMs: NOW - 200000, lon: 3, lat: 3 },
    ];
    const picked = pickSignificantQuakes(rows, { limit: 8, minMag: 4.5 });
    assert.deepEqual(picked.map((q) => q.id), ['new', 'mid', 'old']);
  });

  it('caps at the configured limit', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `q${i}`,
      mag: 5.0,
      originTimeMs: NOW - i * 1000,
      lon: 0,
      lat: 0,
    }));
    const picked = pickSignificantQuakes(rows, { limit: WAVEFRONT_QUAKE_LIMIT });
    assert.equal(picked.length, WAVEFRONT_QUAKE_LIMIT);
    assert.equal(picked[0].id, 'q0');
  });
});

describe('seismicWaves source', () => {
  it('fetches the USGS 4.5+ day feed and normalizes features', async () => {
    const payload = { features: [feature(), feature({ id: 'q2', mag: 4.4 })] };
    const seen = [];
    const fetchImpl = async (url, opts) => {
      seen.push(url);
      return { ok: true, json: async () => payload };
    };
    const source = createUsgsWavefrontSource({ fetchImpl });
    const rows = await source.getSnapshot({});
    assert.match(seen[0], /4\.5_day\.geojson$/);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].mag, 5.2);
  });

  it('throws on HTTP errors and malformed payloads', async () => {
    const bad = createUsgsWavefrontSource({
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    await assert.rejects(() => bad.getSnapshot({}), /USGS HTTP 500/);
    const malformed = createUsgsWavefrontSource({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    });
    await assert.rejects(() => malformed.getSnapshot({}), /Malformed USGS/);
  });
});
