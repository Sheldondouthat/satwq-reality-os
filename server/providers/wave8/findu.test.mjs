import assert from 'node:assert/strict';
import test from 'node:test';
import { finduProxy, _finduInternals } from './findu.js';

const {
  DEFAULT_CALL,
  PRIYOM_LINKS,
  sanitizeCallsign,
  parseFinduWxpage,
  PARTIAL_REASON,
  clearCaches,
} = _finduInternals;

// ——— harness ———

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(body) {
      chunks.push(body);
      res.body = chunks.join('');
    },
    once() {},
    removeListener() {},
  };
  return res;
}

function mount(provider) {
  const calls = [];
  provider.configureServer({
    middlewares: { use: (route, handler) => calls.push({ route, handler }) },
  });
  provider.configurePreviewServer({
    middlewares: { use: (route, handler) => calls.push({ route, handler }) },
  });
  return calls;
}

const htmlResponse = (html) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => html,
});

// ——— parser tests ———

const NO_REPORTS_HTML = [
  '<TITLE>Weather Conditions At KD4PBS</TITLE>',
  '<center><h2>Sorry, no weather reports for KD4PBS...</h2></center>',
].join('\n');

test('sanitizeCallsign accepts real callsigns, rejects garbage', () => {
  assert.equal(sanitizeCallsign('kd4pbs'), 'KD4PBS');
  assert.equal(sanitizeCallsign('EW2208'), 'EW2208');
  assert.equal(sanitizeCallsign('../../etc'), null);
  assert.equal(sanitizeCallsign('a'.repeat(20)), null);
  assert.equal(sanitizeCallsign(null), null);
});

test('parseFinduWxpage reports no-reports honestly (no invented weather)', () => {
  const { hasReports, fields } = parseFinduWxpage(NO_REPORTS_HTML, 'KD4PBS');
  assert.equal(hasReports, false);
  assert.deepEqual(fields, {});
});

test('parseFinduWxpage best-effort extracts labels when present', () => {
  const html = [
    '<html><body><table>',
    '<tr><td>Temperature:</td><td>72.1 F</td></tr>',
    '<tr><td>Humidity:</td><td>45 %</td></tr>',
    '<tr><td>Pressure:</td><td>29.92 inHg</td></tr>',
    '<tr><td>Wind:</td><td>NW 5 mph</td></tr>',
    '</table></body></html>',
  ].join('\n');
  const { hasReports, fields } = parseFinduWxpage(html, 'KD4PBS');
  assert.equal(hasReports, true);
  assert.ok(fields.temperature.includes('72.1'));
  assert.ok(fields.humidity.includes('45'));
  assert.ok(fields.pressure.includes('29.92'));
  assert.ok(fields.wind.includes('NW'));
});

test('parseFinduWxpage tolerates unrecognized layouts (empty fields, still hasReports)', () => {
  const html =
    '<html><body><p>some weather station page with no labels we know</p></body></html>';
  const { hasReports, fields } = parseFinduWxpage(html, 'KD4PBS');
  assert.equal(hasReports, true);
  assert.deepEqual(fields, { reportedCallsign: 'KD4PBS' });
});

// ——— handler tests ———

test('handler mounts /api/findu, defaults to KD4PBS, always partial + Priyom link-out', async () => {
  clearCaches();
  const seen = [];
  const provider = finduProxy({
    fetchImpl: async (url, opts) => {
      seen.push([url, opts]);
      return htmlResponse(NO_REPORTS_HTML);
    },
  });
  const calls = mount(provider);
  assert.equal(calls[0].route, '/api/findu');
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/findu' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen[0][1].redirect, 'follow');
  assert.ok(
    seen[0][0].includes('call=KD4PBS'),
    `URL must carry the default callsign: ${seen[0][0]}`,
  );
  const body = JSON.parse(res.body);
  assert.equal(body.partial, true);
  assert.equal(body.partialReason, PARTIAL_REASON);
  assert.equal(body.callsign, DEFAULT_CALL);
  assert.equal(body.hasReports, false);
  assert.equal(body.priyom.length, 1);
  assert.equal(body.priyom[0].url, PRIYOM_LINKS[0].url);
  assert.ok(body.priyom[0].note.includes('link-out'));
});

test('handler honors ?call= and rejects invalid callsigns with 400', async () => {
  clearCaches();
  const seen = [];
  const provider = finduProxy({
    fetchImpl: async (url) => {
      seen.push(url);
      return htmlResponse(NO_REPORTS_HTML);
    },
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/findu?call=EW2208' }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(seen[0].includes('call=EW2208'));
  assert.equal(JSON.parse(res.body).callsign, 'EW2208');

  const res2 = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/findu?call=../x' }, res2);
  assert.equal(res2.statusCode, 400);
});

test('handler 502s honestly when findu is unreachable (no cache)', async () => {
  clearCaches();
  const abortError = () =>
    Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
  const provider = finduProxy({
    fetchImpl: async () => {
      throw abortError();
    },
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/findu' }, res);
  assert.equal(res.statusCode, 502);
});

test('handler serves stale cache when the refresh fails', async () => {
  clearCaches();
  const now0 = Date.parse('2026-09-27T20:00:00Z');
  const provider = finduProxy({
    fetchImpl: async () => htmlResponse(NO_REPORTS_HTML),
    now: () => now0,
  });
  const calls = mount(provider);
  const res1 = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/findu' }, res1);
  assert.equal(res1.statusCode, 200);

  const provider2 = finduProxy({
    fetchImpl: async () => {
      throw Object.assign(new Error('boom'), { status: 502 });
    },
    now: () => now0 + 11 * 60_000, // past the 10-min TTL, inside the 6h stale window
  });
  const calls2 = mount(provider2);
  const res2 = fakeRes();
  await calls2[0].handler({ method: 'GET', url: '/api/findu' }, res2);
  assert.equal(res2.statusCode, 200);
  const body = JSON.parse(res2.body);
  assert.equal(body.stale, true);
  assert.equal(body.partial, true);
  clearCaches();
});

test('handler rejects non-GET with 405', async () => {
  clearCaches();
  const provider = finduProxy({
    fetchImpl: async () => htmlResponse(NO_REPORTS_HTML),
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'POST', url: '/api/findu' }, res);
  assert.equal(res.statusCode, 405);
});
