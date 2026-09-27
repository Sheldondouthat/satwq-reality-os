import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SHORTWAVE_ROUTE,
  bandForMhz,
  buildOracle,
  dayNightFactor,
  kpPenalty,
  mufEstimate,
  scoreBand,
  shortwaveOracleProxy,
  verdictFor,
  ORACLE_BANDS,
} from './shortwave.js';

// — band mapping —

test('bandForMhz maps ham frequencies', () => {
  assert.equal(bandForMhz(14.2), '20m');
  assert.equal(bandForMhz(7.1), '40m');
  assert.equal(bandForMhz(1.9), '160m');
  assert.equal(bandForMhz(50.3), null); // 6m not in oracle table
  assert.equal(bandForMhz(NaN), null);
});

test('ORACLE_BANDS covers HF 1.8–30 MHz without gaps in the table sense', () => {
  assert.ok(ORACLE_BANDS.length >= 15);
  const names = ORACLE_BANDS.map((b) => b.name);
  assert.ok(names.includes('20m') && names.includes('41m') && names.includes('31m'));
  for (let i = 1; i < ORACLE_BANDS.length; i++) {
    assert.ok(ORACLE_BANDS[i].lo >= ORACLE_BANDS[i - 1].lo, 'sorted by lo');
  }
});

// — MUF model —

test('mufEstimate is sane at F10.7=101 (observed 2026-09-27)', () => {
  const m = mufEstimate(101);
  // foF2 = 2.2+0.026*101 = 4.826 → day MUF ≈ 15.9, night ≈ 8.0
  assert.ok(Math.abs(m.dayMufMhz - 15.9) < 0.2, `day=${m.dayMufMhz}`);
  assert.ok(Math.abs(m.nightMufMhz - 8.0) < 0.2, `night=${m.nightMufMhz}`);
  assert.ok(m.dayMufMhz > m.nightMufMhz);
});

test('mufEstimate returns nulls for unknown flux', () => {
  const m = mufEstimate(null);
  assert.equal(m.dayMufMhz, null);
  assert.equal(m.nightMufMhz, null);
});

// — sky heuristics —

test('dayNightFactor favors high bands by day, low bands by night', () => {
  assert.ok(dayNightFactor(14.2, 12) > dayNightFactor(14.2, 0));
  assert.ok(dayNightFactor(3.6, 0) > dayNightFactor(3.6, 12));
});

test('kpPenalty depresses HF during storms', () => {
  assert.equal(kpPenalty(2), 1);
  assert.ok(kpPenalty(5) < 1 && kpPenalty(5) > kpPenalty(7));
  assert.equal(kpPenalty(null), 1);
});

// — scoring —

test('scoreBand blends measured/scheduled/sky and labels components', () => {
  const band = { name: '20m', centerMhz: 14.175 };
  const r = scoreBand({ band, wsprCount: 30, wsprMedianSnr: -10, eibiCount: 5, kp: 1, hourUtc: 12 });
  assert.ok(r.score >= 0 && r.score <= 100, `score=${r.score}`);
  assert.ok(r.components.measured > 0.5, 'measured dominates with 30 spots');
  assert.ok(r.components.sky > 0.8, 'daytime 20m sky is good at Kp 1');
});

test('scoreBand reaches "wide open" with strong measured activity', () => {
  const band = { name: '20m', centerMhz: 14.175 };
  const spots = Array.from({ length: 60 }, (_, i) => -8 - (i % 5));
  const r = scoreBand({
    band,
    wsprCount: spots.length,
    wsprMedianSnr: -10,
    eibiCount: 0,
    kp: 1,
    hourUtc: 12,
  });
  assert.ok(r.score >= 70, `score=${r.score}`);
  assert.equal(verdictFor(r.score), 'wide open (model)');
});

test('scoreBand returns null with no data', () => {
  const band = { name: '20m', centerMhz: 14.175 };
  assert.equal(scoreBand({ band, wsprCount: null, eibiCount: null, kp: 1, hourUtc: 12 }), null);
});

test('verdictFor labels every tier as model', () => {
  assert.equal(verdictFor(null), 'no data');
  assert.ok(verdictFor(85).includes('model'));
  assert.ok(verdictFor(50).includes('model'));
  assert.ok(verdictFor(20).includes('model'));
  assert.ok(verdictFor(5).includes('model'));
});

// — buildOracle —

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0); // 12:00 UTC, daytime Atlantic

test('buildOracle aggregates WSPR + EiBi into band rows', () => {
  const spots = [
    { band: '20m', snrDb: -12, timeMs: NOW - 5 * 60_000, freqHz: 14_097_000 },
    { band: '20m', snrDb: -18, timeMs: NOW - 10 * 60_000, freqHz: 14_097_000 },
    { band: '40m', snrDb: -20, timeMs: NOW - 60 * 60_000, freqHz: 7_040_000 }, // too old
  ];
  const eibiOnAir = [
    { freqKhz: 15260, station: 'Test BC' }, // 19m
    { freqKhz: 15265, station: 'Test BC 2' },
  ];
  const o = buildOracle({ eibiOnAir, spots, flux: 101, kp: 1, nowMs: NOW });
  const b20 = o.bands.find((b) => b.band === '20m');
  assert.equal(b20.wsprSpots30m, 2);
  assert.equal(b20.wsprMedianSnrDb, -12);
  // 2 spots = weak measured activity → "fair" tier is the honest verdict
  assert.ok(b20.score >= 30 && b20.score < 70, `20m score=${b20.score}`);
  assert.equal(b20.verdict, 'fair (model)');
  const b40 = o.bands.find((b) => b.band === '40m');
  assert.equal(b40.wsprSpots30m, 0, 'stale spot excluded');
  const b19 = o.bands.find((b) => b.band === '19m');
  assert.equal(b19.eibiOnAir, 2);
  assert.equal(b19.eibiExample, 'Test BC');
  assert.ok(o.bestBand && o.bestBand.score >= b20.score);
  assert.equal(o.solar.flux10cm, 101);
  assert.equal(o.solar.kp, 1);
  assert.ok(o.muf.dayMufMhz > 10);
  assert.ok(o.honesty.includes('HEURISTIC'));
});

test('buildOracle degrades to unknown when everything is missing', () => {
  const o = buildOracle({ nowMs: NOW });
  assert.equal(o.solar.flux10cm, null);
  assert.equal(o.muf.dayMufMhz, null);
  assert.equal(o.bestBand, null);
  assert.ok(o.bands.every((b) => b.score === null && b.verdict === 'no data'));
});

// — provider with mocked fetch —

test('shortwaveOracleProxy composes siblings + SWPC end-to-end (mocked)', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    if (u.endsWith('/api/eibi')) {
      return json({ onAir: [{ freqKhz: 15260, station: 'Mock BC', itu: 'D' }] });
    }
    if (u.endsWith('/api/invisible-ocean/spots')) {
      return json({ spots: [{ band: '20m', snrDb: -12, timeMs: Date.now() - 60_000, freqHz: 14_097_000 }] });
    }
    if (u.includes('10cm-flux')) return json([{ flux: 101, time_tag: '2026-09-26T20:00:00' }]);
    if (u.includes('k_index')) {
      return json([{ time_tag: '2026-09-27T06:03:00', kp_index: 2, estimated_kp: 2 }]);
    }
    throw new Error(`unexpected ${u}`);
  };
  const proxy = shortwaveOracleProxy({ fetchImpl, ttlMs: 60_000, timeoutMs: 10_000 });
  let captured;
  const res = {
    headersSent: false,
    writeHead(s) { this.status = s; },
    end(b) { captured = { status: this.status, body: JSON.parse(b) }; },
  };
  await new Promise((resolve) => {
    proxy.configureServer({ middlewares: { use(route, handler) {
      assert.equal(route, SHORTWAVE_ROUTE);
      resolve(handler({ method: 'GET', headers: { host: 'localhost:5173' } }, res));
    } } });
  });
  assert.equal(captured.status, 200);
  const o = captured.body;
  assert.equal(o.solar.flux10cm, 101);
  assert.equal(o.solar.kp, 2);
  assert.equal(o.sources.eibiOnAir, 1);
  assert.equal(o.sources.wsprSpots30m, 1);
  assert.ok(o.bands.find((b) => b.band === '19m').eibiOnAir === 1);
  assert.ok(o.bands.find((b) => b.band === '20m').wsprSpots30m === 1);
});

test('shortwaveOracleProxy degrades when siblings are down but SWPC is up', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/api/eibi') || u.includes('/api/invisible-ocean')) {
      throw new Error('sibling down');
    }
    const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    if (u.includes('10cm-flux')) return json([{ flux: 88, time_tag: '2026-09-26T20:00:00' }]);
    if (u.includes('k_index')) return json([{ time_tag: '2026-09-27T06:03:00', kp_index: 6 }]);
    throw new Error(`unexpected ${u}`);
  };
  const proxy = shortwaveOracleProxy({ fetchImpl, ttlMs: 60_000, timeoutMs: 10_000 });
  let captured;
  const res = {
    headersSent: false,
    writeHead(s) { this.status = s; },
    end(b) { captured = { status: this.status, body: JSON.parse(b) }; },
  };
  await new Promise((resolve) => {
    proxy.configureServer({ middlewares: { use(route, handler) {
      resolve(handler({ method: 'GET', headers: { host: 'localhost:5173' } }, res));
    } } });
  });
  assert.equal(captured.status, 200);
  assert.equal(captured.body.solar.flux10cm, 88);
  assert.equal(captured.body.solar.kp, 6);
  assert.equal(captured.body.upstream.eibi, 'sibling down');
  // Kp 6 storm: every scored band's sky component is penalized
  for (const b of captured.body.bands) {
    if (b.components) assert.ok(b.components.sky <= 0.45, `${b.band} sky=${b.components.sky}`);
  }
});
