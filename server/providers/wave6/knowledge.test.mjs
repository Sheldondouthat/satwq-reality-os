import assert from 'node:assert/strict';
import test from 'node:test';
import { knowledgeProxy, _knowledgeInternals } from './knowledge.js';

const { parseWikimediaPageviews, parseWorldBank, parseOpenLibrary, parseMusicBrainz, parseClinicalTrials, buildSnapshot } = _knowledgeInternals;

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { chunks.push(body); res.body = chunks.join(''); },
  };
  return res;
}

function fakeReq(url, method = 'GET') {
  return { method, url, on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

const WIKI = { items: [{ views: 400 }, { views: 600 }, { views: 0 }] };
const WB = [{ page: 1 }, [{ date: '2024', value: 340110988 }, { date: '2023', value: 339996563 }]];
const OL = {
  numFound: 12,
  docs: [{ key: '/works/OL1W', title: 'Solar Wind', author_name: ['A. Author'], first_publish_year: 1999 }],
};
const MB = {
  artists: [{ id: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', name: 'Radiohead', disambiguation: '', 'life-span': { begin: '1985' }, country: 'GB' }],
};
const TRIALS = {
  studies: [
    { protocolSection: { identificationModule: { nctId: 'NCT00000001', briefTitle: 'A Study of X' }, statusModule: { overallStatus: 'RECRUITING' } } },
  ],
};

test('knowledgeProxy mounts /api/knowledge on both server shapes', () => {
  const routes = mount(knowledgeProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/knowledge', '/api/knowledge']);
});

test('parseWikimediaPageviews sums views into one fact card', () => {
  const items = parseWikimediaPageviews(WIKI, 'Earth');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'pageviews');
  assert.match(items[0].headline, /1,000×/);
  assert.match(items[0].link, /wikipedia\.org\/wiki\/Earth/);
});

test('parseWorldBank picks the latest non-null value', () => {
  const items = parseWorldBank(WB);
  assert.equal(items.length, 1);
  assert.match(items[0].headline, /340,110,988/);
  assert.match(items[0].headline, /2024/);
});

test('parseWorldBank returns [] when no values exist', () => {
  assert.deepEqual(parseWorldBank([{ page: 1 }, [{ date: '2024', value: null }]]), []);
});

test('parseOpenLibrary builds book cards with links', () => {
  const items = parseOpenLibrary(OL);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'books');
  assert.equal(items[0].headline, 'Solar Wind');
  assert.match(items[0].detail, /A\. Author/);
  assert.equal(items[0].link, 'https://openlibrary.org/works/OL1W');
});

test('parseMusicBrainz builds artist cards', () => {
  const items = parseMusicBrainz(MB);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'music');
  assert.equal(items[0].headline, 'Radiohead');
  assert.match(items[0].detail, /1985/);
  assert.match(items[0].link, /musicbrainz\.org\/artist\/a74b1b7f/);
});

test('parseClinicalTrials builds trial cards', () => {
  const items = parseClinicalTrials(TRIALS);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'trials');
  assert.equal(items[0].headline, 'A Study of X');
  assert.match(items[0].detail, /NCT00000001/);
  assert.match(items[0].link, /clinicaltrials\.gov\/study\/NCT00000001/);
});

test('buildSnapshot merges items and records per-source errors', () => {
  const payload = buildSnapshot([
    { key: 'wikimedia', ok: true, count: 1, attribution: 'Wikimedia', latencyMs: 4, items: parseWikimediaPageviews(WIKI) },
    { key: 'musicbrainz', ok: false, count: 0, attribution: 'MB', latencyMs: 2, error: 'timeout', items: [] },
  ]);
  assert.equal(payload.count, 1);
  assert.equal(payload.items[0].kind, 'pageviews');
  assert.equal(payload.sources.musicbrainz.ok, false);
  assert.equal(payload.sources.musicbrainz.error, 'timeout');
});

test('handler serves merged ticker with mocked fetch', async () => {
  _knowledgeInternals.clearCaches();
  const calls = mount(knowledgeProxy());
  const realFetch = globalThis.fetch;
  const bodies = [WIKI, WB, OL, MB, TRIALS];
  let n = 0;
  globalThis.fetch = async () => new Response(JSON.stringify(bodies[n++ % bodies.length]), { status: 200 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/knowledge'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 5);
    assert.ok(payload.items.every((i) => i.headline && i.link));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when every source fails', async () => {
  _knowledgeInternals.clearCaches();
  const calls = mount(knowledgeProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 429 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/knowledge'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /knowledge_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(knowledgeProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/knowledge', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
