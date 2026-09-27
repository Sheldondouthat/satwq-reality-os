import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ORCASOUND_ROUTE,
  describeOrcasound,
  extractFeeds,
  normalizeFeed,
  orcasoundProxy,
  parseNextData,
} from './orcasound.js';

const NEXT_FIXTURE = {
  props: {
    pageProps: {
      dehydratedState: {
        queries: [{
          state: {
            data: {
              feeds: [
                {
                  bucket: 'audio-orcasound-net',
                  name: 'Orcasound Lab',
                  nodeName: 'rpi_orcasound_lab',
                  slug: 'orcasound-lab',
                  online: true,
                  latLng: { lat: 48.5583362, lng: -123.1735774 },
                  thumbUrl: 'https://x/thumbnail.png',
                },
                {
                  bucket: 'audio-orcasound-net',
                  name: 'MaST Center Aquarium',
                  nodeName: 'rpi_mast_center',
                  slug: 'mast-center',
                  online: false,
                  latLng: { lat: 47.34922, lng: -122.32512 },
                  thumbUrl: null,
                },
                { name: 'Bad Feed', nodeName: '', latLng: { lat: 0, lng: 0 } },
              ],
            },
          },
        }],
      },
    },
  },
};

const HTML_FIXTURE =
  `<html><head><script id="__NEXT_DATA__" type="application/json">` +
  JSON.stringify(NEXT_FIXTURE) +
  `</script></head></html>`;

test('parseNextData extracts the embedded JSON', () => {
  const d = parseNextData(HTML_FIXTURE);
  assert.ok(d && d.props.pageProps);
  assert.equal(parseNextData('<html></html>'), null);
  assert.equal(parseNextData(null), null);
});

test('extractFeeds finds the feeds array', () => {
  const feeds = extractFeeds(parseNextData(HTML_FIXTURE));
  assert.equal(feeds.length, 3);
  assert.deepEqual(extractFeeds({}), []);
});

test('normalizeFeed keeps good feeds and drops bad ones', () => {
  const feeds = extractFeeds(parseNextData(HTML_FIXTURE));
  const good = normalizeFeed(feeds[0]);
  assert.equal(good.name, 'Orcasound Lab');
  assert.equal(good.nodeName, 'rpi_orcasound_lab');
  assert.equal(good.online, true);
  assert.ok(good.latestTxtUrl.includes('rpi_orcasound_lab/latest.txt'));
  assert.ok(good.playlistTemplate.includes('{ts}'));
  const offline = normalizeFeed(feeds[1]);
  assert.equal(offline.online, false);
  assert.equal(normalizeFeed(feeds[2]), null, 'empty nodeName dropped');
  assert.equal(normalizeFeed({ name: 'x', nodeName: 'y', latLng: { lat: 999, lng: 0 } }), null, 'bad lat');
});

test('describeOrcasound counts online feeds', () => {
  const doc = describeOrcasound({
    feeds: [{ online: true }, { online: false }].map((f, i) => ({ ...f, name: `n${i}` })),
    fetchedAt: '2026-09-27T00:00:00Z',
  });
  assert.equal(doc.count, 2);
  assert.equal(doc.onlineCount, 1);
  assert.ok(doc.honesty.includes('no call-detection claims'));
});

function mockFetch(map) {
  return async (url) => {
    const u = String(url);
    for (const [k, v] of Object.entries(map)) {
      if (u.includes(k)) {
        return { ok: true, status: 200, text: async () => v };
      }
    }
    throw new Error('unexpected url ' + u);
  };
}

function mount(proxy) {
  const handlers = new Map();
  proxy.configureServer({ middlewares: { use(r, h) { handlers.set(r, h); } } });
  return handlers;
}

test('orcasoundProxy serves registry with resolved playlists (mocked)', async () => {
  const handlers = mount(orcasoundProxy({
    fetchImpl: mockFetch({ 'live.orcasound.net/listen': HTML_FIXTURE, 'latest.txt': '1790406012\n' }),
  }));
  assert.ok(handlers.has(ORCASOUND_ROUTE));
  const r = await new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(s) { this.status = s; },
      end(b) { resolve({ status: this.status, body: JSON.parse(b) }); },
    };
    handlers.get(ORCASOUND_ROUTE)({ method: 'GET', url: '/' }, res);
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 2);
  const lab = r.body.hydrophones.find((h) => h.nodeName === 'rpi_orcasound_lab');
  assert.ok(lab.hlsUrl.includes('/hls/1790406012/live.m3u8'), `hlsUrl=${lab.hlsUrl}`);
  assert.equal(lab.streamLive, true);
  const mast = r.body.hydrophones.find((h) => h.nodeName === 'rpi_mast_center');
  assert.equal(mast.hlsUrl, null, 'offline feed gets no playlist');
});

test('orcasoundProxy 503s when upstream is down and cache is empty', async () => {
  const handlers = mount(orcasoundProxy({
    fetchImpl: async () => { throw new Error('net down'); },
  }));
  const r = await new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(s) { this.status = s; },
      end(b) { resolve({ status: this.status, body: JSON.parse(b) }); },
    };
    handlers.get(ORCASOUND_ROUTE)({ method: 'GET', url: '/' }, res);
  });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'orcasound_unavailable');
});
