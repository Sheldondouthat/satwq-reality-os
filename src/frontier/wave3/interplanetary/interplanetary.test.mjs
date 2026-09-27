/**
 * Interplanetary layer tests — node:test, REAL assertions.
 *
 * parseHorizonsVectors is exercised against a genuine JPL Horizons VECTOR
 * table captured live 2026-09-27 (Voyager 1, COMMAND='-31'); the middleware
 * is smoke-tested with a stubbed fetch.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHorizonsVectors,
  interplanetaryProxy,
} from '../../../../server/providers/wave3/interplanetary.js';
import {
  logRadius01,
  eclipticAngleRad,
  formatDistance,
  formatLightTime,
} from './index.js';

// Genuine Horizons $$SOE block — Voyager 1, fetched live 2026-09-27.
const REAL_SOE = `2461310.500000000 = A.D. 2026-Sep-27 00:00:00.0000 TDB \n X =-4.810994269915822E+09 Y =-2.046473498487451E+10 Z = 1.480609229156624E+10\n VX=-2.059438918952375E+00 VY=-1.360701260059561E+01 VZ= 9.831772577438459E+00\n LT= 8.577018185401536E+04 RG= 2.571325364112225E+10 RR= 1.687619909456403E+01`;
const REAL_RESULT = `header noise\n$$SOE\n${REAL_SOE}\n$$EOE\ntrailer`;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('parseHorizonsVectors (live Horizons data)', () => {
  it('parses the Voyager 1 vector block', () => {
    const v = parseHorizonsVectors(REAL_RESULT);
    assert.ok(v, 'expected a parsed vector');
    assert.ok(Math.abs(v.xKm - -4.810994269915822e9) < 1e3, `xKm=${v.xKm}`);
    assert.ok(Math.abs(v.yKm - -2.046473498487451e10) < 1e3, `yKm=${v.yKm}`);
    assert.ok(Math.abs(v.zKm - 1.480609229156624e10) < 1e3, `zKm=${v.zKm}`);
    // One-way light time ≈ 23.8 h — Voyager 1 is the most distant craft.
    assert.ok(Math.abs(v.lightTimeS / 3600 - 23.83) < 0.05, `ltHrs=${v.lightTimeS / 3600}`);
    // Range ≈ 171.9 AU.
    const au = v.rangeKm / 149597870.7;
    assert.ok(au > 171 && au < 173, `distAu=${au}`);
    // Speed ≈ 16.9 km/s.
    const speed = Math.hypot(v.vxKms, v.vyKms, v.vzKms);
    assert.ok(speed > 16 && speed < 18, `speed=${speed}`);
  });

  it('returns null when the ephemeris table is absent', () => {
    assert.equal(parseHorizonsVectors('no markers here'), null);
    assert.equal(parseHorizonsVectors('$$SOE\n$$EOE'), null);
    assert.equal(parseHorizonsVectors(null), null);
    assert.equal(parseHorizonsVectors('{"result":"$$SOE\n X =abc\n$$EOE"}'), null);
  });
});

describe('log-scale chart math', () => {
  it('maps the chart edges to 0 and 1', () => {
    assert.equal(logRadius01(0.2), 0);
    assert.equal(logRadius01(250), 1);
  });

  it('is monotonic and puts Earth inside Voyager 1', () => {
    const r1 = logRadius01(1);
    const r171 = logRadius01(171.9);
    assert.ok(r1 > 0 && r1 < 1, `r(1 AU)=${r1}`);
    assert.ok(r171 > r1, `r(171.9)=${r171} should exceed r(1)=${r1}`);
    // Log compression: the 1→10 AU decade spans more pixels than 100→171.9.
    const decade = logRadius01(10) - logRadius01(1);
    const tail = logRadius01(171.9) - logRadius01(100);
    assert.ok(decade > tail, `decade=${decade} tail=${tail}`);
  });

  it('rejects non-positive distances', () => {
    assert.equal(logRadius01(0), null);
    assert.equal(logRadius01(-5), null);
    assert.equal(logRadius01(NaN), null);
  });

  it('eclipticAngleRad matches atan2', () => {
    assert.ok(Math.abs(eclipticAngleRad(1, 0) - 0) < 1e-12);
    assert.ok(Math.abs(eclipticAngleRad(0, 1) - Math.PI / 2) < 1e-12);
  });
});

describe('formatters', () => {
  it('formats AU distances', () => {
    assert.equal(formatDistance(171.9), '171.9 AU');
    assert.equal(formatDistance(1.016), '1.02 AU');
    assert.equal(formatDistance(NaN), '—');
  });

  it('formats light time in hours or minutes', () => {
    assert.equal(formatLightTime(23.825), '23.8 light-hr');
    assert.equal(formatLightTime(0.5), '30.0 light-min');
    assert.equal(formatLightTime(null), '—');
  });
});

describe('interplanetaryProxy middleware', () => {
  it('serves one record per craft from stubbed Horizons', async () => {
    const canned = JSON.stringify({ result: REAL_RESULT });
    globalThis.fetch = async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(canned).buffer,
    });
    let handler = null;
    let route = null;
    interplanetaryProxy().configureServer({
      middlewares: { use: (p, h) => { route = p; handler = h; } },
    });
    assert.equal(route, '/api/interplanetary');
    let status = 0;
    let body = '';
    await handler(
      { method: 'GET' },
      {
        writeHead: (s) => { status = s; },
        end: (b) => { body = b; },
      },
    );
    assert.equal(status, 200);
    const payload = JSON.parse(body);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.craft.length, 6, 'six configured craft');
    const vgr1 = payload.craft.find((c) => c.id === 'vgr1');
    assert.ok(vgr1, 'Voyager 1 present');
    assert.ok(vgr1.distAu > 171 && vgr1.distAu < 173, `vgr1 distAu=${vgr1.distAu}`);
    assert.match(payload.frameNote, /never/i);
  });

  it('rejects non-GET', async () => {
    let handler = null;
    interplanetaryProxy().configureServer({
      middlewares: { use: (p, h) => { handler = h; } },
    });
    let status = 0;
    await handler({ method: 'POST' }, { writeHead: (s) => { status = s; }, end: () => {} });
    assert.equal(status, 405);
  });
});
