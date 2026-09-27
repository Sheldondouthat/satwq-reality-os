/**
 * Spacetime ripples tests — node:test, REAL assertions.
 *
 * extractClassification is exercised against a genuine GraceDB GCN-notice
 * fragment captured live 2026-09-27 (superevent MS260927f, a mock
 * injection); the middleware shape and sky-overlay helpers are asserted
 * directly.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractClassification,
  farDescription,
  gracedbProxy,
} from '../../../../server/providers/wave3/gracedb.js';
import {
  badgeFor,
  classificationBars,
  formatGraceTime,
} from './index.js';

// Genuine /event/classification from MS260927f-initial.json (live 2026-09-27).
const REAL_CLASS_FRAGMENT =
  `"event": {"classification": {"BNS": 0.9999969016748887, "NSBH": 0.0, "BBH": 0.0, "Terrestrial": 3.0983251113470313e-06}, "other": 1}`;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('extractClassification (live GraceDB notice)', () => {
  it('extracts the BNS-dominated classification', () => {
    const c = extractClassification(REAL_CLASS_FRAGMENT);
    assert.ok(c, 'expected a classification');
    assert.ok(Math.abs(c.BNS - 0.9999969016748887) < 1e-12, `BNS=${c.BNS}`);
    assert.equal(c.NSBH, 0);
    assert.equal(c.BBH, 0);
    assert.ok(c.Terrestrial > 0 && c.Terrestrial < 1e-5, `Terrestrial=${c.Terrestrial}`);
  });

  it('returns null when no classification block exists', () => {
    assert.equal(extractClassification('{"event": {}}'), null);
    assert.equal(extractClassification('not json at all'), null);
    assert.equal(extractClassification(null), null);
  });

  it('tolerates truncated notice text via regex', () => {
    // A 512 KB cap may cut the file mid-JSON; the regex still finds the block
    // as long as the classification object itself is intact.
    const cut = REAL_CLASS_FRAGMENT.slice(0, REAL_CLASS_FRAGMENT.indexOf('}, "other"') + 1);
    const c = extractClassification(cut);
    assert.ok(c && c.BNS > 0.99, `BNS=${c?.BNS}`);
  });
});

describe('farDescription', () => {
  it('describes the MDC false-alarm rate as ~1 per 348k years', () => {
    const d = farDescription(9.110699364861297e-14);
    assert.ok(d.startsWith('1 per ~'), d);
    const years = Number(d.match(/~([0-9,]+)/)[1].replace(/,/g, ''));
    assert.ok(years > 300000 && years < 400000, `years=${years}`);
  });

  it('handles frequent rates', () => {
    assert.match(farDescription(1e-7), /per year/);
    assert.equal(farDescription(NaN), null);
    assert.equal(farDescription(0), null);
  });
});

describe('sky-overlay helpers', () => {
  it('badges categories honestly', () => {
    assert.deepEqual(badgeFor('Production'), { text: 'REAL ALERT', tone: '#7CFFB2' });
    assert.deepEqual(badgeFor('MDC'), { text: 'MOCK INJECTION', tone: '#ffb454' });
    assert.deepEqual(badgeFor('Test'), { text: 'TEST EVENT', tone: '#8aa4d6' });
  });

  it('builds classification bars in BNS/NSBH/BBH/Terrestrial order', () => {
    const bars = classificationBars({ BNS: 0.9, NSBH: 0, BBH: 0.1, Terrestrial: 0 });
    assert.deepEqual(bars, [
      { key: 'BNS', pct: 90 },
      { key: 'BBH', pct: 10 },
    ]);
    assert.deepEqual(classificationBars(null), []);
  });

  it('formats GraceDB timestamps', () => {
    assert.equal(formatGraceTime('2026-09-27 05:28:50 UTC'), 'Sep 27, 2026 05:28 UTC');
    assert.equal(formatGraceTime(''), '—');
  });
});

describe('gracedbProxy middleware', () => {
  it('mounts on /api/gravwaves and rejects non-GET', async () => {
    let handler = null;
    let route = null;
    gracedbProxy().configureServer({
      middlewares: { use: (p, h) => { route = p; handler = h; } },
    });
    assert.equal(route, '/api/gravwaves');
    let status = 0;
    await handler({ method: 'POST' }, { writeHead: (s) => { status = s; }, end: () => {} });
    assert.equal(status, 405);
  });
});
