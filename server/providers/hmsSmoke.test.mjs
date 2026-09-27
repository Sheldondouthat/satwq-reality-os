import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hmsSmokeProxy,
  hmsSmokeUtcDateParts,
  hmsSmokeDayUrl,
  hmsSmokeCandidateUrls,
  pickHmsSmokeCandidate,
  HMS_SMOKE_ROUTE,
} from './hmsSmoke.js';

test('hmsSmokeUtcDateParts derives UTC calendar parts, not local time', () => {
  // 2026-09-26 12:00 UTC — local timezone must not shift the day.
  const parts = hmsSmokeUtcDateParts(new Date(Date.UTC(2026, 8, 26, 12, 0, 0)));
  assert.deepEqual(parts, { y: '2026', m: '09', ymd: '20260926' });
  const edge = hmsSmokeUtcDateParts(new Date(Date.UTC(2026, 0, 5, 23, 59, 59)));
  assert.equal(edge.ymd, '20260105');
});

test('hmsSmokeDayUrl builds the exact HMS path shape', () => {
  assert.equal(
    hmsSmokeDayUrl({ y: '2026', m: '09', ymd: '20260926' }),
    'https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/2026/09/hms_smoke20260926.kml',
  );
});

test('hmsSmokeCandidateUrls returns today-then-yesterday in UTC', () => {
  const [today, yesterday] = hmsSmokeCandidateUrls(
    new Date(Date.UTC(2026, 8, 26, 12, 0, 0)),
  );
  assert.equal(today.date, '20260926');
  assert.ok(today.url.endsWith('/2026/09/hms_smoke20260926.kml'));
  assert.equal(yesterday.date, '20260925');
  assert.ok(yesterday.url.endsWith('/2026/09/hms_smoke20260925.kml'));
});

test('hmsSmokeCandidateUrls crosses month and year boundaries', () => {
  const [today, yesterday] = hmsSmokeCandidateUrls(
    new Date(Date.UTC(2026, 9, 1, 0, 30, 0)),
  );
  assert.equal(today.date, '20261001');
  assert.ok(today.url.endsWith('/2026/10/hms_smoke20261001.kml'));
  assert.equal(yesterday.date, '20260930');
  assert.ok(yesterday.url.endsWith('/2026/09/hms_smoke20260930.kml'));

  const [ny, nye] = hmsSmokeCandidateUrls(new Date(Date.UTC(2026, 0, 1, 6, 0, 0)));
  assert.equal(ny.date, '20260101');
  assert.ok(ny.url.endsWith('/2026/01/hms_smoke20260101.kml'));
  assert.equal(nye.date, '20251231');
  assert.ok(nye.url.endsWith('/2025/12/hms_smoke20251231.kml'));
});

test('pickHmsSmokeCandidate prefers today, falls back to yesterday', () => {
  const todayOk = { date: '20260926', url: 'u1', ok: true, looksLikeKml: true };
  const yestOk = { date: '20260925', url: 'u2', ok: true, looksLikeKml: true };
  assert.equal(pickHmsSmokeCandidate([todayOk, yestOk]), todayOk);
  assert.equal(
    pickHmsSmokeCandidate([
      { ...todayOk, ok: false },
      yestOk,
    ]),
    yestOk,
  );
  // HTTP-ok but not KML (error page) is not a success — keep falling back.
  assert.equal(
    pickHmsSmokeCandidate([
      { ...todayOk, looksLikeKml: false },
      yestOk,
    ]),
    yestOk,
  );
  assert.equal(
    pickHmsSmokeCandidate([
      { ...todayOk, ok: false },
      { ...yestOk, ok: false },
    ]),
    null,
  );
  assert.equal(pickHmsSmokeCandidate([]), null);
});

test('hmsSmokeProxy exposes the expected Vite plugin shape', () => {
  const plugin = hmsSmokeProxy();
  assert.equal(plugin.name, 'hms-smoke-proxy');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  assert.equal(HMS_SMOKE_ROUTE, '/api/hms-smoke');
});
