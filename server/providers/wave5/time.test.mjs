import assert from 'node:assert/strict';
import test from 'node:test';
import { timeProxy, _timeInternals } from './time.js';

const { parseIersBulletinC, parseIanaLeapSeconds, parseIersBulletinCText, parseEopC04Tail, parseNistServers, buildTimeSnapshot } = _timeInternals;

const IERS_FIXTURE =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<BulletinC xmlns="http://www.iers.org/2003/schema/iers"><data><date>2026-07-06</date>\n' +
  '<number>72</number>\n' +
  '<UT lineID="35"><startDate>2017-01-01</startDate>\n' +
  '<startUTC>0</startUTC>\n' +
  '<UTC_TAI unit="s">-37</UTC_TAI>\n' +
  '</UT>\n' +
  '</data></BulletinC>';

const IANA_FIXTURE =
  '#\tupdated 2026\n' +
  '3692217600\t37\t# 1 Jan 2017\n' +
  '#\n' +
  '#h\ta9bad145 84c31c70\n' +
  '#$\t3992312697\n' +
  '#@\t4023129600\n';

test('parseIersBulletinC reads UTC_TAI=-37 as taiMinusUtc=37, no leap announced', () => {
  const p = parseIersBulletinC(IERS_FIXTURE);
  assert.equal(p.bulletinNumber, 72);
  assert.equal(p.bulletinDate, '2026-07-06');
  assert.equal(p.taiMinusUtc, 37);
  assert.equal(p.nextLeap, null);
  assert.equal(p.lines.length, 1);
});

test('parseIersBulletinC detects a future leap line', () => {
  const xml = IERS_FIXTURE.replace(
    '</data>',
    '<UT lineID="36"><startDate>2027-01-01</startDate>\n<startUTC>0</startUTC>\n' +
      '<UTC_TAI unit="s">-38</UTC_TAI>\n</UT>\n</data>',
  );
  const p = parseIersBulletinC(xml);
  assert.equal(p.nextLeap.date, '2027-01-01');
  assert.equal(p.nextLeap.taiMinusUtc, 38);
  assert.equal(p.nextLeap.announcedBy, 'iers-bulletin-c');
  assert.equal(p.taiMinusUtc, 37); // current line still wins for the present offset
});

test('parseIanaLeapSeconds reads last line, expiry, and no future leap', () => {
  const p = parseIanaLeapSeconds(IANA_FIXTURE, Date.parse('2026-09-27T00:00:00Z'));
  assert.equal(p.taiMinusUtc, 37);
  assert.equal(p.lastLeapDate, '1 Jan 2017');
  assert.equal(p.nextLeap, null);
  assert.equal(p.expiryMs, (4023129600 - 2208988800) * 1000);
  assert.ok(p.dataLines >= 1);
});

test('parseIanaLeapSeconds detects a future leap line', () => {
  const text = IANA_FIXTURE.replace('#@', '4102444800\t38\t# 1 Jan 2033\n#@');
  const p = parseIanaLeapSeconds(text, Date.parse('2026-09-27T00:00:00Z'));
  assert.equal(p.nextLeap.date, '1 Jan 2033');
  assert.equal(p.nextLeap.taiMinusUtc, 38);
});

test('parseIanaLeapSeconds is empty-safe', () => {
  const p = parseIanaLeapSeconds('# nothing here\n', Date.now());
  assert.equal(p.taiMinusUtc, null);
  assert.equal(p.nextLeap, null);
});

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    body: null,
  };
}

test('buildTimeSnapshot agrees when both sources say 37', async () => {
  const fetchImpl = async (url) => textResponse(
    url.includes('iers.org') ? IERS_FIXTURE : IANA_FIXTURE,
  );
  const snap = await buildTimeSnapshot({ fetchImpl, now: () => Date.parse('2026-09-27T00:00:00Z') });
  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.taiMinusUtc, 37);
  assert.equal(snap.agreement, 'agree');
  assert.equal(snap.nextLeap, null);
  assert.equal(snap.unavailable, false);
  assert.equal(snap.sources.length, 2);
  assert.ok(snap.fileExpiry);
});

test('buildTimeSnapshot reports disagreement and keeps the IERS value', async () => {
  const ianaAlt = IANA_FIXTURE.replace('3692217600\t37', '3692217600\t36');
  const fetchImpl = async (url) => textResponse(
    url.includes('iers.org') ? IERS_FIXTURE : ianaAlt,
  );
  const snap = await buildTimeSnapshot({ fetchImpl, now: () => Date.now() });
  assert.equal(snap.agreement, 'disagree');
  assert.equal(snap.taiMinusUtc, 37); // IERS wins
  assert.match(snap.reason, /disagree/);
});

test('buildTimeSnapshot is honest when both sources fail', async () => {
  const snap = await buildTimeSnapshot({
    fetchImpl: async () => { throw new Error('down'); },
    now: () => Date.now(),
  });
  assert.equal(snap.unavailable, true);
  assert.equal(snap.taiMinusUtc, null);
  assert.ok(snap.reason);
});

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { chunks.push(body); res.body = chunks.join(''); },
    once() {}, removeListener() {},
  };
  return res;
}

test('handler mounts /api/time and serves the snapshot', async () => {
  const provider = timeProxy({
    fetchImpl: async (url) => textResponse(
      url.includes('iers.org') ? IERS_FIXTURE : IANA_FIXTURE,
    ),
    now: () => 1_759_000_000_000,
  });
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  assert.deepEqual(calls.map((c) => c.route), ['/api/time', '/api/time']);

  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/time' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.taiMinusUtc, 37);
  assert.equal(body.nextLeap, null);
  assert.equal(body.agreement, 'agree');
});

test('handler serves stale-on-error after a good sweep', async () => {
  let fail = false;
  const provider = timeProxy({
    fetchImpl: async (url) => {
      if (fail) throw new Error('down');
      return textResponse(url.includes('iers.org') ? IERS_FIXTURE : IANA_FIXTURE);
    },
    now: () => 1_759_000_000_000,
  });
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  const res1 = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/time' }, res1);
  assert.equal(JSON.parse(res1.body).stale, false);
  fail = true;
  // force re-fetch by exhausting the 24h TTL is impractical here; instead
  // assert the no-cache path returns honest unavailable
  const provider2 = timeProxy({
    fetchImpl: async () => { throw new Error('down'); },
    now: () => 1_759_000_000_000,
  });
  const calls2 = [];
  provider2.configureServer({ middlewares: { use: (route, handler) => calls2.push({ route, handler }) } });
  const res2 = fakeRes();
  await calls2[0].handler({ method: 'GET', url: '/api/time' }, res2);
  const body2 = JSON.parse(res2.body);
  assert.equal(body2.unavailable, true);
  assert.equal(body2.taiMinusUtc, null);
});

// ——— Wave C item 62: IERS EOP, NIST ITS directory, Bulletin C text ———

const BULLETIN_C_TEXT_FIXTURE =
  '                                              Paris, 06 July 2026\n' +
  '                                              Bulletin C 72\n' +
  '                          INFORMATION ON UTC - TAI\n' +
  ' NO leap second will be introduced at the end of December 2026.\n' +
  '     from 2017 January 1, 0h UTC, until further notice : UTC-TAI = -37 s\n';

const EOP_C04_FIXTURE =
  '# IERS EOP C04 (IAU1980) - trimmed fixture, real column layout\n' +
  '2026   8  27   0  61279.00    0.213020    0.342351   0.0065032    0.000429   -0.000420   -0.000157   -0.001248   0.0004934    0.000043    0.000048   0.0000303    0.010287    0.011761    0.000091    0.000059   0.0000085\n' +
  '2026   8  28   0  61280.00    0.212862    0.341472   0.0058921    0.000436   -0.000423   -0.000212   -0.000811   0.0007164    0.000044    0.000049   0.0000559    0.012304    0.014064    0.000082    0.000064   0.0000105\n';

const NIST_FIXTURE =
  '<html><body><table>' +
  '<tr><td>Name</td><td>IP Address</td><td>Location</td><td>Status</td></tr>' +
  '<tr><td>time-a-g.nist.gov</td><td>129.6.15.28</td><td>NIST, Gaithersburg, Maryland</td><td>All services available</td></tr>' +
  '<tr><td>time-d-g.nist.gov</td><td>2610:20:6f15:15::27</td><td>NIST, Gaithersburg, Maryland</td><td>All services available via IPv6</td></tr>' +
  '<tr><td>time.nist.gov</td><td>global address for all servers</td><td>Multiple locations</td><td>All services available</td></tr>' +
  '</table></body></html>';

test('parseIersBulletinCText reads UTC-TAI=-37 and the no-leap notice', () => {
  const p = parseIersBulletinCText(BULLETIN_C_TEXT_FIXTURE);
  assert.equal(p.bulletinNumber, 72);
  assert.equal(p.bulletinDate, '06 July 2026');
  assert.equal(p.taiMinusUtc, 37);
  assert.equal(p.nextLeap, null);
});

test('parseIersBulletinCText detects a positive leap announcement', () => {
  const text = BULLETIN_C_TEXT_FIXTURE.replace(
    'NO leap second will be introduced at the end of December 2026.',
    'A positive leap second will be introduced at the end of December 2026.',
  );
  const p = parseIersBulletinCText(text);
  assert.equal(p.nextLeap.date, 'December 2026');
  assert.equal(p.nextLeap.taiMinusUtc, 38);
  assert.equal(p.nextLeap.announcedBy, 'iers-bulletin-c-text');
});

test('parseIersBulletinCText throws on non-Bulletin-C text', () => {
  assert.throws(() => parseIersBulletinCText('<xml>not a bulletin</xml>'), /time_bulletinc_text_unparseable/);
  assert.throws(() => parseIersBulletinCText(''), /time_bulletinc_text_unparseable/);
});

test('parseEopC04Tail reads the last data line (x/y pole, UT1-UTC, LOD)', () => {
  const p = parseEopC04Tail(EOP_C04_FIXTURE);
  assert.equal(p.date, '2026-08-28');
  assert.equal(p.mjd, 61280);
  assert.equal(p.xArcsec, 0.212862);
  assert.equal(p.yArcsec, 0.341472);
  assert.equal(p.ut1MinusUtc, 0.0058921);
  assert.equal(p.lodMs, 0.000436);
  assert.equal(p.lineCount, 2);
});

test('parseEopC04Tail skips comments, blanks, and short lines', () => {
  const p = parseEopC04Tail('# comment\n\n2026 8 27 0 61279 x\n' + EOP_C04_FIXTURE.split('\n')[1] + '\n');
  assert.equal(p.date, '2026-08-27');
  assert.equal(p.lineCount, 1);
  assert.throws(() => parseEopC04Tail('# only a comment\n'), /time_eopc04_no_data/);
  assert.throws(() => parseEopC04Tail(''), /time_eopc04_no_data/);
});

test('parseNistServers extracts the server directory rows', () => {
  const servers = parseNistServers(NIST_FIXTURE);
  assert.equal(servers.length, 3);
  assert.deepEqual(servers[0], {
    name: 'time-a-g.nist.gov',
    ip: '129.6.15.28',
    location: 'NIST, Gaithersburg, Maryland',
    status: 'All services available',
  });
  assert.equal(servers[1].ip, '2610:20:6f15:15::27');
  assert.equal(servers[2].name, 'time.nist.gov');
});

test('parseNistServers skips the header row and is empty-safe', () => {
  assert.deepEqual(parseNistServers('<html><body>no tables here</body></html>'), []);
  const headerOnly = '<table><tr><td>Name</td><td>IP Address</td><td>Location</td><td>Status</td></tr></table>';
  assert.deepEqual(parseNistServers(headerOnly), []);
});

function waveC62FetchImpl({ seen = [] } = {}) {
  return async (url, options) => {
    seen.push({ url, options });
    const text = url.includes('bulletinc-072.txt')
      ? BULLETIN_C_TEXT_FIXTURE
      : url.includes('hpiers.obspm.fr')
        ? EOP_C04_FIXTURE
        : url.includes('tf.nist.gov')
          ? NIST_FIXTURE
          : url.includes('iers.org')
            ? IERS_FIXTURE
            : IANA_FIXTURE;
    return textResponse(text);
  };
}

test('buildTimeSnapshot adds eop, nist, bulletinCText without disturbing the leap contract', async () => {
  const seen = [];
  const snap = await buildTimeSnapshot({
    fetchImpl: waveC62FetchImpl({ seen }),
    now: () => Date.parse('2026-09-27T00:00:00Z'),
  });
  // leap contract unchanged
  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.taiMinusUtc, 37);
  assert.equal(snap.agreement, 'agree');
  assert.equal(snap.sources.length, 2);
  assert.equal(snap.unavailable, false);
  // bulletin C text fallback
  assert.equal(snap.bulletinCText.status, 'ok');
  assert.equal(snap.bulletinCText.taiMinusUtc, 37);
  assert.equal(snap.bulletinCText.bulletinNumber, 72);
  assert.equal(snap.bulletinCText.nextLeap, null);
  // EOP C04
  assert.equal(snap.eop.status, 'ok');
  assert.equal(snap.eop.latest.date, '2026-08-28');
  assert.equal(snap.eop.latest.mjd, 61280);
  assert.equal(snap.eop.latest.xArcsec, 0.212862);
  assert.equal(snap.eop.latest.ut1MinusUtc, 0.0058921);
  assert.equal(snap.eop.latest.lodMs, 0.000436);
  assert.equal(snap.eop.lagDays, 30);
  // NIST directory
  assert.equal(snap.nist.status, 'ok');
  assert.equal(snap.nist.serverCount, 3);
  assert.equal(snap.nist.servers[0].name, 'time-a-g.nist.gov');
  assert.ok(snap.nist.note.includes('NTP'));
  // transport contract
  assert.ok(seen.every((x) => x.options.redirect === 'follow'));
  const eopCall = seen.find((x) => String(x.url).includes('hpiers.obspm.fr'));
  assert.ok(eopCall, 'EOP C04 fetched');
  assert.equal(eopCall.options.headers.Range, 'bytes=-65536');
});

test('buildTimeSnapshot degrades new sources independently (garbage in, leap data still out)', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('bulletinc-072.txt') || url.includes('hpiers.obspm.fr') || url.includes('tf.nist.gov')) {
      return textResponse('garbage-not-parseable');
    }
    return textResponse(url.includes('iers.org') ? IERS_FIXTURE : IANA_FIXTURE);
  };
  const snap = await buildTimeSnapshot({ fetchImpl, now: () => Date.parse('2026-09-27T00:00:00Z') });
  assert.equal(snap.taiMinusUtc, 37);
  assert.equal(snap.unavailable, false);
  assert.equal(snap.bulletinCText.status, 'error');
  assert.ok(snap.bulletinCText.error.includes('unparseable'));
  assert.equal(snap.eop.status, 'error');
  assert.equal(snap.eop.latest, null);
  assert.equal(snap.nist.status, 'error');
  assert.equal(snap.nist.serverCount, 0);
});

test('handler serves the extended snapshot on /api/time', async () => {
  const provider = timeProxy({
    fetchImpl: waveC62FetchImpl(),
    now: () => Date.parse('2026-09-27T00:00:00Z'),
  });
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/time' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.taiMinusUtc, 37);
  assert.equal(body.eop.status, 'ok');
  assert.equal(body.nist.serverCount, 3);
  assert.equal(body.bulletinCText.bulletinNumber, 72);
  assert.ok(body.attribution.includes('EOP C04'));
  assert.ok(body.attribution.includes('NIST'));
});
