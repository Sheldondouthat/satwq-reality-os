/**
 * Wave 9 — edge self-probe tests.
 *
 * All network behavior is exercised through a fake fetch harness: the
 * product logic under test is classification + query handling, which is
 * deterministic. Live-bytes anchoring is impossible by design (the route
 * IS the live probe); instead, the fake fixtures mirror the VM probe-run
 * shapes: a 200-JSON feed, a 200-HTML CAPTCHA challenge (kiwisdr class), a
 * 403 bot-wall, a 429, a 404, and an aborted fetch (000).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TARGETS,
  classifyResult,
  extractTitle,
  probeOne,
  buildPayload,
  parseQuery,
  numOrNull,
  priorVmVerdict,
  _selfProbeInternals as internals,
} from './selfProbe.js';

function fakeResponse({ status = 200, body = '', contentType = 'text/plain', url = 'https://x.test/', redirected = false }) {
  return {
    status,
    url,
    redirected,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    async arrayBuffer() { return new TextEncoder().encode(body).buffer; },
  };
}

const fakeFetchFor = (responder) => async (url, opts) => responder(url, opts);

test('classifyResult: 200 JSON body -> reachable + feedCandidate', () => {
  const c = classifyResult({ code: 200, contentType: 'application/json', bodyStart: '{"a":1}' });
  assert.equal(c.verdict, 'reachable');
  assert.equal(c.feedCandidate, true);
  assert.equal(c.botWall, false);
});

test('classifyResult: 200 HTML CAPTCHA page -> bot-wall, no feed candidate', () => {
  const c = classifyResult({
    code: 200,
    contentType: 'text/html',
    bodyStart: '<html><head><title>rx.kiwisdr.com</title></head><body><link rel="stylesheet" href="captcha.css">',
  });
  assert.equal(c.verdict, 'bot-wall');
  assert.equal(c.botWall, true);
  assert.equal(c.feedCandidate, false);
});

test('classifyResult: 200 editorial HTML -> reachable, no feed candidate', () => {
  const c = classifyResult({
    code: 200,
    contentType: 'text/html',
    bodyStart: '<!doctype html><html><head><title>Weather For Sailing</title>',
  });
  assert.equal(c.verdict, 'reachable');
  assert.equal(c.feedCandidate, false);
  assert.ok(c.note.includes('no machine-readable feed'));
});

test('classifyResult: 403 -> bot-wall; 429 -> rate-limited; 404 -> not-found; 503 -> server-error; abort -> unreachable', () => {
  assert.equal(classifyResult({ code: 403, contentType: 'text/html', bodyStart: 'x' }).verdict, 'bot-wall');
  assert.equal(classifyResult({ code: 429, contentType: 'application/json', bodyStart: '{}' }).verdict, 'rate-limited');
  assert.equal(classifyResult({ code: 404, contentType: 'text/html', bodyStart: 'Not Found' }).verdict, 'not-found');
  assert.equal(classifyResult({ code: 503, contentType: 'text/html', bodyStart: 'x' }).verdict, 'server-error');
  const c = classifyResult({ code: 0, error: 'fetch failed' });
  assert.equal(c.verdict, 'unreachable');
  assert.ok(c.note.includes('not VM-egress-specific'));
});

test('classifyResult: 200 XML feed -> reachable + feedCandidate', () => {
  const c = classifyResult({ code: 200, contentType: 'application/xml', bodyStart: '<?xml version="1.0"?><rss>' });
  assert.equal(c.verdict, 'reachable');
  assert.equal(c.feedCandidate, true);
});

test('extractTitle: pulls <title> from HTML, null without one', () => {
  assert.equal(extractTitle('<html><head><title>rx.kiwisdr.com</title></head>'), 'rx.kiwisdr.com');
  assert.equal(extractTitle('{"json":true}'), null);
  assert.equal(extractTitle(''), null);
});

test('probeOne: 200 JSON endpoint -> full row shape', async () => {
  const fetchImpl = fakeFetchFor(() => fakeResponse({
    status: 200, body: '{"features":[]}', contentType: 'application/geo+json',
    url: 'https://apis.is/earthquake/is', redirected: true,
  }));
  const row = await probeOne(TARGETS.find((t) => t.id === 'apis-is'), fetchImpl);
  assert.equal(row.id, 'apis-is');
  assert.equal(row.code, 200);
  assert.equal(row.ok, true);
  assert.equal(row.redirected, true);
  assert.equal(row.verdict, 'reachable');
  assert.equal(row.feedCandidate, true);
  assert.equal(row.contentType, 'application/geo+json');
  assert.ok(row.bytesRead > 0);
  assert.equal(typeof row.at, 'string');
});

test('probeOne: fetch abort -> code 0, unreachable, priorVmVerdict attached', async () => {
  const fetchImpl = fakeFetchFor(() => { throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }); });
  const row = await probeOne(TARGETS.find((t) => t.id === 'acars'), fetchImpl);
  assert.equal(row.code, 0);
  assert.equal(row.ok, false);
  assert.equal(row.verdict, 'unreachable');
  assert.equal(row.priorVmVerdict, 'vm:000 (30 consecutive runs)');
});

test('probeOne: 404 IODA path -> not-found with movement note', async () => {
  const fetchImpl = fakeFetchFor(() => fakeResponse({ status: 404, body: 'Not Found', contentType: 'text/html' }));
  const row = await probeOne(TARGETS.find((t) => t.id === 'ioda'), fetchImpl);
  assert.equal(row.code, 404);
  assert.equal(row.verdict, 'not-found');
  assert.ok(row.note.includes('API may have moved'));
  assert.equal(row.priorVmVerdict, 'vm:404 (host reachable, path absent)');
});

test('buildPayload: summary counts + edgeNewlyReachable metric', () => {
  const rows = [
    { id: 'acars', verdict: 'unreachable', feedCandidate: false, ok: false, priorVmVerdict: 'vm:000 (30 consecutive runs)' },
    { id: 'apis-is', verdict: 'reachable', feedCandidate: true, ok: true, priorVmVerdict: 'vm:000 (30 consecutive runs)' },
    { id: 'kiwisdr', verdict: 'bot-wall', feedCandidate: false, ok: true, priorVmVerdict: 'vm:https-000 / http-200-CAPTCHA-challenge' },
    { id: 'ioda', verdict: 'not-found', feedCandidate: false, ok: false, priorVmVerdict: 'vm:404 (host reachable, path absent)' },
    { id: 'control', verdict: 'reachable', feedCandidate: false, ok: true, priorVmVerdict: 'vm:200 (revival holds)' },
  ];
  const p = buildPayload(rows, false, { target: 'all' });
  assert.equal(p.summary.total, 5);
  assert.equal(p.summary.reachable, 2);
  assert.equal(p.summary.feedCandidates, 1);
  assert.equal(p.summary.botWalls, 1);
  assert.equal(p.summary.notFound, 1);
  assert.equal(p.summary.unreachable, 1);
  // apis-is is the money case: VM 000, edge 200.
  assert.equal(p.summary.edgeNewlyReachable, 1);
  assert.equal(p.stale, false);
  assert.ok(p.honesty.census.includes('Connectivity census'));
});

test('parseQuery: default all, single id, requestedNotFound, badParam', () => {
  assert.deepEqual(parseQuery(new URLSearchParams('')), { targetId: 'all' });
  assert.deepEqual(parseQuery(new URLSearchParams('target=kiwisdr')), { targetId: 'kiwisdr' });
  const nf = parseQuery(new URLSearchParams('target=atlantis'));
  assert.equal(nf.requestedNotFound, true);
  assert.equal(parseQuery(new URLSearchParams('target=BAD!!')).badParam, 'selfprobe_bad_target');
});

test('TARGETS: 12 entries, unique ids, https urls, no duplicates', () => {
  assert.equal(TARGETS.length, 12);
  const ids = TARGETS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of TARGETS) {
    assert.ok(t.url.startsWith('https://'), `${t.id} must be https`);
    assert.ok(t.label.length > 0);
  }
});

test('priorVmVerdict: every target has a recorded VM verdict', () => {
  for (const t of TARGETS) {
    const v = priorVmVerdict(t.id);
    assert.ok(v && v.startsWith('vm:'), `${t.id} missing VM verdict`);
  }
});

test('numOrNull: empty string is null, never 0', () => {
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull('0'), 0);
  assert.equal(numOrNull('1,234'), 1234);
});

test('internals expose the probe machinery and resetCache', () => {
  assert.equal(typeof internals.probeOne, 'function');
  assert.equal(typeof internals.classifyResult, 'function');
  assert.equal(typeof internals.resetCache, 'function');
  internals.resetCache();
});
