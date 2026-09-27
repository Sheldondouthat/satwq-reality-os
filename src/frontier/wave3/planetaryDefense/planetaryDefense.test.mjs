/**
 * Planetary defense board tests — node:test, REAL assertions.
 *
 * transformCadRow is exercised against a genuine CNEOS cad.api row captured
 * live 2026-09-27 (2026 SA8); the middleware is smoke-tested with a stubbed
 * fetch.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  diameterRangeM,
  auToLunarDistances,
  transformCadRow,
  neoProxy,
} from '../../../../server/providers/wave3/neo.js';
import {
  sortByMissDistance,
  tintForLd,
  formatLd,
  formatDiameter,
} from './index.js';

// Genuine cad.api response shape — fetched live 2026-09-27.
const REAL_FIELDS = ['des', 'orbit_id', 'jd', 'cd', 'dist', 'dist_min', 'dist_max', 'v_rel', 'v_inf', 't_sigma_f', 'h', 'fullname'];
const REAL_ROW_SA8 = ['2026 SA8', '1', '2461311.781406648', '2026-Sep-28 06:45', '0.00253925938809526', '0.00250538178713651', '0.00257309430106221', '6.61131689150686', '6.45064988171152', '00:22', '28.634', '       (2026 SA8)'];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('transformCadRow (live CNEOS data)', () => {
  it('transforms the 2026 SA8 row', () => {
    const r = transformCadRow(REAL_FIELDS, REAL_ROW_SA8);
    assert.equal(r.des, '2026 SA8');
    assert.equal(r.closeApproachUtc, '2026-Sep-28 06:45');
    // 0.002539 AU ≈ 0.988 lunar distances — inside the Moon's orbit.
    assert.ok(Math.abs(r.distLd - 0.988) < 0.01, `distLd=${r.distLd}`);
    assert.ok(Math.abs(r.vRelKms - 6.61) < 0.01, `vRel=${r.vRelKms}`);
    assert.equal(r.absMagH, 28.634);
    assert.ok(r.diameterEstM.loM > 4 && r.diameterEstM.loM < 6, `lo=${r.diameterEstM.loM}`);
    assert.ok(r.diameterEstM.hiM > 10 && r.diameterEstM.hiM < 13, `hi=${r.diameterEstM.hiM}`);
    assert.match(r.diameterNote, /ESTIMATED/);
  });

  it('handles a missing H gracefully', () => {
    const row = [...REAL_ROW_SA8];
    row[REAL_FIELDS.indexOf('h')] = '';
    const r = transformCadRow(REAL_FIELDS, row);
    assert.equal(r.diameterEstM, null);
    assert.match(r.diameterNote, /not estimable/);
  });
});

describe('diameterRangeM', () => {
  it('brackets the H=22 benchmark (~110–250 m)', () => {
    // H=22 is the canonical ~140 m object; albedo range must bracket it.
    const d = diameterRangeM(22);
    assert.ok(d.loM < 140 && d.hiM > 140, `lo=${d.loM} hi=${d.hiM}`);
  });

  it('returns null for non-finite H', () => {
    assert.equal(diameterRangeM(NaN), null);
    assert.equal(diameterRangeM(null), null);
  });
});

describe('auToLunarDistances', () => {
  it('converts 0.00257 AU to ~1 LD', () => {
    const ld = auToLunarDistances(0.00257);
    assert.ok(Math.abs(ld - 1) < 0.01, `ld=${ld}`);
  });
});

describe('board helpers', () => {
  it('sorts by ascending miss distance', () => {
    const sorted = sortByMissDistance([
      { des: 'b', distLd: 5 },
      { des: 'a', distLd: 0.5 },
      { des: 'c', distLd: null },
    ]);
    assert.deepEqual(sorted.map((r) => r.des), ['a', 'b', 'c']);
  });

  it('tints by proximity', () => {
    assert.equal(tintForLd(0.5), 'inside-lunar');
    assert.equal(tintForLd(3), 'near');
    assert.equal(tintForLd(20), 'distant');
    assert.equal(tintForLd(NaN), 'unknown');
  });

  it('formats lunar distances and diameters', () => {
    assert.equal(formatLd(0.988), '0.99 LD');
    assert.equal(formatLd(25.4), '25 LD');
    assert.equal(formatDiameter({ loM: 4.99, hiM: 11.15 }), '5.0 m – 11 m (est.)');
    assert.equal(formatDiameter(null), 'unknown');
  });
});

describe('neoProxy middleware', () => {
  it('serves transformed approaches from stubbed cad.api', async () => {
    const canned = JSON.stringify({
      signature: { source: 'NASA/JPL SBDB Close Approach Data API' },
      count: 1,
      fields: REAL_FIELDS,
      data: [REAL_ROW_SA8],
    });
    globalThis.fetch = async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(canned).buffer,
    });
    let handler = null;
    let route = null;
    neoProxy().configureServer({
      middlewares: { use: (p, h) => { route = p; handler = h; } },
    });
    assert.equal(route, '/api/neo');
    let status = 0;
    let body = '';
    await handler(
      { method: 'GET' },
      { writeHead: (s) => { status = s; }, end: (b) => { body = b; } },
    );
    assert.equal(status, 200);
    const payload = JSON.parse(body);
    assert.equal(payload.count, 1);
    assert.equal(payload.approaches[0].des, '2026 SA8');
    assert.ok(payload.physicsNotes.length >= 2, 'physics notes present');
  });

  it('rejects non-GET', async () => {
    let handler = null;
    neoProxy().configureServer({ middlewares: { use: (p, h) => { handler = h; } } });
    let status = 0;
    await handler({ method: 'POST' }, { writeHead: (s) => { status = s; }, end: () => {} });
    assert.equal(status, 405);
  });
});
