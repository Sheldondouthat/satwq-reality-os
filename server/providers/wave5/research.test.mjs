import assert from 'node:assert/strict';
import test from 'node:test';
import { researchProxy, _researchInternals } from './research.js';

const {
  normDoi, normTitle, parseArxivAtom, dedupeWorks,
  trimOpenAlex, trimCrossref, trimPubMed, trimResearchPayload,
} = _researchInternals;

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

const OPENALEX_WORK = {
  id: 'https://openalex.org/W1',
  doi: 'https://doi.org/10.1234/solar.wind',
  title: 'Solar wind turbulence at 1 AU',
  publication_date: '2026-01-15',
  authorships: [{ author: { display_name: 'Ada Lovelace' } }],
  primary_location: { source: { display_name: 'Astrophys J' } },
};

const CROSSREF_ITEM = {
  DOI: '10.1234/solar.wind', // same DOI as OpenAlex work → dedupe target
  title: ['Solar wind turbulence at 1 AU'],
  author: [{ given: 'A.', family: 'Lovelace' }],
  published: { 'date-parts': [[2026, 1, 15]] },
  'container-title': ['The Astrophysical Journal'],
  URL: 'https://doi.org/10.1234/solar.wind',
};

const PUBMED_DOC = {
  title: 'Solar wind effects on the magnetosphere',
  authors: [{ name: 'Curie M' }, { name: 'Bohr N' }],
  pubdate: '2026 Feb',
  source: 'Space Sci Rev',
  elocationid: 'doi: 10.5678/magnet',
};

const ARXIV_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
<id>http://arxiv.org/abs/2601.00001v1</id>
<updated>2026-01-01T00:00:00Z</updated>
<published>2026-01-01T00:00:00Z</published>
<title>Electron   transport in the solar wind</title>
<author><name>Tesla, Nikola</name></author>
<summary>We study electron  transport.</summary>
</entry>
<entry>
<id>http://arxiv.org/abs/2601.00002v1</id>
<published>2026-01-02T00:00:00Z</published>
<title>Solar wind turbulence at 1 AU</title>
<author><name>Einstein, Albert</name></author>
<summary>Duplicate of the OpenAlex/Crossref title, no DOI — title-fallback dedupe.</summary>
</entry>
</feed>`;

test('researchProxy mounts /api/research on both server shapes', () => {
  const routes = mount(researchProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/research', '/api/research']);
});

test('normDoi strips doi.org prefixes and lowercases', () => {
  assert.equal(normDoi('https://doi.org/10.1234/X'), '10.1234/x');
  assert.equal(normDoi('10.1234/X'), '10.1234/x');
  assert.equal(normDoi(''), '');
});

test('trimOpenAlex extracts fields', () => {
  const w = trimOpenAlex(OPENALEX_WORK);
  assert.equal(w.feed, 'openalex');
  assert.equal(w.doi, '10.1234/solar.wind');
  assert.deepEqual(w.authors, ['Ada Lovelace']);
  assert.equal(w.venue, 'Astrophys J');
});

test('trimCrossref extracts date parts and authors', () => {
  const w = trimCrossref(CROSSREF_ITEM);
  assert.equal(w.feed, 'crossref');
  assert.equal(w.published, '2026-01-15');
  assert.deepEqual(w.authors, ['A. Lovelace']);
});

test('trimPubMed builds pubmed URL', () => {
  const w = trimPubMed('12345', PUBMED_DOC);
  assert.equal(w.url, 'https://pubmed.ncbi.nlm.nih.gov/12345/');
  assert.equal(w.doi, '10.5678/magnet');
});

test('parseArxivAtom parses entries, whitespace, and version suffix', () => {
  const entries = parseArxivAtom(ARXIV_XML);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, 'Electron transport in the solar wind');
  assert.deepEqual(entries[0].authors, ['Tesla, Nikola']);
  assert.equal(entries[0].url, 'http://arxiv.org/abs/2601.00001');
  assert.equal(entries[0].summary, 'We study electron transport.');
});

test('dedupeWorks merges DOI and title duplicates, records alsoSeen', () => {
  const items = dedupeWorks([
    [trimOpenAlex(OPENALEX_WORK)],
    [trimCrossref(CROSSREF_ITEM)],
    [trimPubMed('999', PUBMED_DOC)],
    parseArxivAtom(ARXIV_XML),
  ]);
  // OpenAlex + Crossref share DOI → 1; arXiv #2 shares title with OpenAlex → 1
  assert.equal(items.length, 3);
  const merged = items.find((i) => i.doi === '10.1234/solar.wind');
  assert.ok(merged);
  assert.deepEqual(merged.alsoSeen.sort(), ['arxiv', 'crossref']);
  assert.equal(merged.feed, 'openalex'); // first occurrence wins
});

test('normTitle makes punctuation-insensitive keys', () => {
  assert.equal(normTitle('Solar wind turbulence at 1 AU!'), normTitle('solar wind turbulence at 1 au'));
});

test('trimResearchPayload tracks degraded sources', () => {
  const payload = trimResearchPayload([
    { name: 'arxiv', result: new Error('paced out') },
    { name: 'pubmed', result: [trimPubMed('1', PUBMED_DOC)] },
  ]);
  assert.deepEqual(payload.degradedSources, ['arxiv']);
  assert.equal(payload.count, 1);
  assert.ok(payload.attribution.includes('arXiv'));
});

test('handler serves deduped snapshot with mocked fetch', async () => {
  _researchInternals.clearCaches();
  const calls = mount(researchProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    assert.equal(init?.redirect, 'follow'); // workerd: 'error' throws at edge (main 2ec4053)
    const u = String(url);
    let body = null;
    let contentType = 'application/json';
    if (u.includes('api.openalex.org')) body = { results: [OPENALEX_WORK] };
    else if (u.includes('api.crossref.org')) body = { message: { items: [CROSSREF_ITEM] } };
    else if (u.includes('esearch.fcgi')) body = { esearchresult: { idlist: ['999'] } };
    else if (u.includes('esummary.fcgi')) body = { result: { uids: ['999'], 999: PUBMED_DOC } };
    else if (u.includes('export.arxiv.org')) { body = ARXIV_XML; contentType = 'application/atom+xml'; }
    assert.ok(body, `unexpected upstream URL ${u}`);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': contentType },
    });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/research'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload.degradedSources, []);
    assert.equal(payload.count, 3); // DOI + title merges
    assert.ok(payload.source.includes('arXiv'));
    assert.match(res.headers['Cache-Control'], /max-age=1800/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when all upstreams are down', async () => {
  _researchInternals.clearCaches();
  const calls = mount(researchProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/research'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /research_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(researchProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/research', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
