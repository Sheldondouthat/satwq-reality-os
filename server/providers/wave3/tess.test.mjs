import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRANSITS_ROUTE,
  bjdToMs,
  buildToiAdql,
  msToBjd,
  nextTransitBjd,
  normalizeToiRow,
  parseTapCsv,
  tessProxy,
} from './tess.js';

// — ADQL —

test('buildToiAdql selects the verified column set', () => {
  const q = buildToiAdql();
  // Regression: st_ra/st_dec are NOT valid TOI columns (ORA-00904) — ra/dec are.
  assert.ok(q.includes(' ra,'), 'uses ra');
  assert.ok(q.includes(' dec,'), 'uses dec');
  assert.ok(!q.includes('st_ra') && !q.includes('st_dec'), 'no st_ra/st_dec');
  assert.ok(q.includes("tfopwg_disp in ('PC','CP')"), 'candidate dispositions only');
  assert.ok(q.includes('select top 500'), 'default top 500');
});

test('buildToiAdql clamps topN', () => {
  assert.ok(buildToiAdql(10).includes('top 50'), 'floor 50');
  assert.ok(buildToiAdql(99999).includes('top 2000'), 'ceiling 2000');
  assert.ok(buildToiAdql(NaN).includes('top 500'), 'NaN → default');
});

// — time conversions —

test('bjdToMs/msToBjd round-trip and anchor on J2000', () => {
  // JD 2451545.0 == 2000-01-01T12:00:00Z
  assert.equal(bjdToMs(2451545.0), Date.UTC(2000, 0, 1, 12, 0, 0));
  const now = Date.now();
  assert.ok(Math.abs(bjdToMs(msToBjd(now)) - now) < 1, 'round-trip < 1ms');
  assert.equal(bjdToMs(NaN), null);
  assert.equal(msToBjd(Infinity), null);
});

// — next transit —

test('nextTransitBjd is epoch + ceil((now-epoch)/period)·period', () => {
  const epoch = 2460000.0;
  const period = 3.5;
  const nowBjd = epoch + 10.0; // 10 days after epoch
  const nowMs = bjdToMs(nowBjd);
  // ceil(10/3.5) = 3 → epoch + 10.5
  assert.equal(nextTransitBjd(epoch, period, nowMs), epoch + 3 * period);
});

test('nextTransitBjd returns the epoch when it is in the future', () => {
  const nowMs = Date.now();
  const future = msToBjd(nowMs) + 2;
  assert.equal(nextTransitBjd(future, 3.5, nowMs), future);
});

test('nextTransitBjd rejects bad inputs', () => {
  assert.equal(nextTransitBjd(NaN, 3.5), null);
  assert.equal(nextTransitBjd(2460000, 0), null);
  assert.equal(nextTransitBjd(2460000, -1), null);
});

// — TAP CSV parsing —

const TAP_FIXTURE =
  'tid,toi,pl_orbper,pl_tranmid,pl_trandurh,pl_rade,ra,dec,st_tmag,tfopwg_disp\n' +
  '1001,1056.01,3.5,2460000.5,2.1,2.3,120.5,45.2,10.1,PC\n' +
  '"1002","1057.01","5.25","2460001.25","3.0","1.8","121.0","-12.3","11.5","CP"\n' +
  '\n' + // blank line must be ignored
  '1003,1059.01,,2460002.0,2.5,2.0,122.0,10.0,12.0,PC\n'; // missing period → dropped later

test('parseTapCsv handles quotes, blank lines, and maps headers', () => {
  const rows = parseTapCsv(TAP_FIXTURE);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].toi, '1056.01');
  assert.equal(rows[1].toi, '1057.01');
  assert.equal(rows[1].pl_orbper, '5.25');
  assert.equal(rows[2].pl_orbper, '');
});

test('parseTapCsv returns [] for empty input', () => {
  assert.deepEqual(parseTapCsv(''), []);
  assert.deepEqual(parseTapCsv('   \n\n'), []);
});

// — row normalization —

test('normalizeToiRow predicts the next transit', () => {
  const r = normalizeToiRow({
    tid: '1001', toi: '1056.01', pl_orbper: '3.5',
    pl_tranmid: String(msToBjd(Date.now()) + 1), // epoch 1 day in the future
    pl_trandurh: '2.1', pl_rade: '2.3', ra: '120.5', dec: '45.2',
    st_tmag: '10.1', tfopwg_disp: 'PC',
  });
  assert.ok(r);
  assert.equal(r.toi, '1056.01');
  assert.equal(r.disposition, 'PC');
  const t = Date.parse(r.nextTransitUtc);
  assert.ok(t > Date.now() && t < Date.now() + 2 * 86400000, 'next transit within 2 days');
});

test('normalizeToiRow drops bad rows', () => {
  const base = {
    tid: '1', toi: '1.01', pl_orbper: '3.5', pl_tranmid: '2460000.5',
    ra: '120.5', dec: '45.2', st_tmag: '10', tfopwg_disp: 'PC',
  };
  assert.equal(normalizeToiRow({ ...base, pl_orbper: '' }), null, 'missing period');
  assert.equal(normalizeToiRow({ ...base, pl_tranmid: '' }), null, 'missing epoch');
  assert.equal(normalizeToiRow({ ...base, dec: '91' }), null, 'dec out of range');
  assert.equal(normalizeToiRow(null), null);
});

// — provider —

function mockFetchTap(csv, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => csv,
  });
}

function callProxy(proxy, url = '/') {
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(s) { this.status = s; },
      end(b) { resolve({ status: this.status, body: JSON.parse(b) }); },
    };
    let handler;
    proxy.configureServer({ middlewares: { use(route, h) {
      assert.equal(route, TRANSITS_ROUTE);
      handler = h;
    } } });
    handler({ method: 'GET', url }, res);
  });
}

test('tessProxy serves sorted upcoming transits (mocked TAP)', async () => {
  const epochBjd = msToBjd(Date.now()) + 0.5; // 12 h out
  const csv =
    'tid,toi,pl_orbper,pl_tranmid,pl_trandurh,pl_rade,ra,dec,st_tmag,tfopwg_disp\n' +
    `1,1.01,10,${epochBjd},2,2,10,10,10,PC\n` +
    `2,2.01,10,${epochBjd + 2},2,2,20,20,10,PC\n`;
  const r = await callProxy(tessProxy({ fetchImpl: mockFetchTap(csv) }), '/?days=30&limit=10');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 2);
  assert.ok(r.body.transits[0].hoursUntil < r.body.transits[1].hoursUntil, 'sorted soonest first');
  assert.ok(r.body.honesty.includes('Kepler'), 'honesty note present');
  assert.equal(r.body.windowDays, 30);
});

test('tessProxy honors the limit param', async () => {
  const epochBjd = msToBjd(Date.now()) + 0.5;
  const rows = Array.from({ length: 5 }, (_, i) =>
    `${i},${i}.01,10,${epochBjd + i},2,2,10,10,10,PC`).join('\n');
  const csv = 'tid,toi,pl_orbper,pl_tranmid,pl_trandurh,pl_rade,ra,dec,st_tmag,tfopwg_disp\n' + rows + '\n';
  const r = await callProxy(tessProxy({ fetchImpl: mockFetchTap(csv) }), '/?days=90&limit=3');
  assert.equal(r.body.count, 3);
});

test('tessProxy 503s when TAP fails and cache is empty', async () => {
  const r = await callProxy(tessProxy({ fetchImpl: mockFetchTap('', 500) }));
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'tess_unavailable');
});

test('tessProxy rejects TAP Oracle error payloads', async () => {
  const bad = 'QUERY_STATUS,xxx\n"ERROR","ORA-00904: invalid identifier"\n';
  const r = await callProxy(tessProxy({ fetchImpl: mockFetchTap(bad) }));
  assert.equal(r.status, 503, 'query error → upstream failure → 503');
});
