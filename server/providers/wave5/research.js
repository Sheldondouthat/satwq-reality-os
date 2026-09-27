/**
 * Wave 5 — Research knowledge ticker proxy (keyless).
 *
 * Merges four scholarly streams into one deduped payload:
 *   #173 OpenAlex  — works (CC0)
 *   #174 Crossref   — works (open, polite pool via User-Agent)
 *   #175 PubMed     — esearch + esummary (NCBI open)
 *   #176 arXiv     — Atom feed (arXiv open; 3 s minimum pacing between requests)
 *
 * Routes:
 *   GET /api/research → {generatedAt, count, items:[...], degradedSources:[], source, attribution}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'error' with pinned hosts, no node: imports, no WASM).
 */

const OPENALEX_HOST = 'api.openalex.org';
const CROSSREF_HOST = 'api.crossref.org';
const PUBMED_HOST = 'eutils.ncbi.nlm.nih.gov';
const ARXIV_HOST = 'export.arxiv.org';

const OPENALEX_URL = `https://${OPENALEX_HOST}/works?search=solar%20wind&per-page=4&sort=publication_date:desc`;
const CROSSREF_URL = `https://${CROSSREF_HOST}/works?query=solar%20wind&rows=4&sort=published&order=desc`;
const PUBMED_ESEARCH_URL = `https://${PUBMED_HOST}/entrez/eutils/esearch.fcgi?db=pubmed&term=solar+wind&retmax=4&sort=date&retmode=json`;
const PUBMED_ESUMMARY_URL = (ids) =>
  `https://${PUBMED_HOST}/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids}&retmode=json`;
const ARXIV_URL = `https://${ARXIV_HOST}/api/query?search_query=all:electron&start=0&max_results=4&sortBy=submittedDate&sortOrder=descending`;

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60_000; // gentle TTL (arXiv politeness)
const ARXIV_MIN_GAP_MS = 3_000; // mandatory pacing between arXiv requests
const TEXT_CAP = 320;
const AUTHORS_CAP = 8;
const USER_AGENT = 'Gods Eye View (public research context; contact via repo)';

let cache = null; // {at, payload}
let inflight = null;
let arxivLastAt = 0; // module-scope pacing gate

function assertPinnedHost(url, host) {
  if (new URL(url).host !== host)
    throw Object.assign(new Error(`research_unexpected_host_${host}`), { status: 502 });
}

async function fetchJsonCapped(url, host, signal) {
  assertPinnedHost(url, host);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`research_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('research_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Mandatory 3 s pacing before every arXiv request, regardless of cache state. */
async function paceArxiv() {
  const wait = ARXIV_MIN_GAP_MS - (Date.now() - arxivLastAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  arxivLastAt = Date.now();
}

async function fetchArxivAtom(url) {
  assertPinnedHost(url, ARXIV_HOST);
  await paceArxiv();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`research_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('research_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

function capText(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + '…' : s;
}

function normDoi(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return '';
  return s.replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
}

function normTitle(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function joinAuthors(names) {
  return names.filter((n) => n).slice(0, AUTHORS_CAP);
}

function trimOpenAlex(work) {
  const authors = joinAuthors(
    (work?.authorships ?? []).map((a) => a?.author?.display_name),
  );
  return {
    feed: 'openalex',
    id: String(work?.id ?? ''),
    title: capText(work?.title),
    authors,
    doi: normDoi(work?.doi),
    published: work?.publication_date ?? null,
    venue: capText(work?.primary_location?.source?.display_name),
    url: String(work?.doi ?? work?.id ?? ''),
  };
}

function trimCrossref(item) {
  const dateParts = item?.published?.['date-parts']?.[0] ?? [];
  const published = dateParts.length
    ? dateParts.map((n) => String(n).padStart(2, '0')).join('-')
    : null;
  const authors = joinAuthors(
    (item?.author ?? []).map((a) =>
      [a?.given, a?.family].filter(Boolean).join(' '),
    ),
  );
  const title = Array.isArray(item?.title) ? item.title[0] : item?.title;
  return {
    feed: 'crossref',
    id: String(item?.DOI ?? ''),
    title: capText(title),
    authors,
    doi: normDoi(item?.DOI),
    published,
    venue: capText(Array.isArray(item?.['container-title']) ? item['container-title'][0] : ''),
    url: String(item?.URL ?? ''),
  };
}

function trimPubMed(uid, doc) {
  const authors = joinAuthors((doc?.authors ?? []).map((a) => a?.name));
  const doiMatch = String(doc?.elocationid ?? '').match(/10\.\d{4,}\/\S+/);
  return {
    feed: 'pubmed',
    id: String(uid),
    title: capText(doc?.title),
    authors,
    doi: normDoi(doiMatch ? doiMatch[0].replace(/[.,;)\]]+$/, '') : ''),
    published: doc?.pubdate ?? null,
    venue: capText(doc?.source),
    url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
  };
}

function atomField(entry, tag) {
  const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function trimArxivEntry(entry) {
  const authors = joinAuthors(
    [...entry.matchAll(/<author[^>]*>\s*<name[^>]*>([\s\S]*?)<\/name>/gi)].map((m) =>
      m[1].replace(/\s+/g, ' ').trim(),
    ),
  );
  const id = atomField(entry, 'id').replace(/v\d+$/, '');
  const doiMatch = atomField(entry, 'arxiv:doi').trim() || atomField(entry, 'doi').trim();
  return {
    feed: 'arxiv',
    id: id || atomField(entry, 'id'),
    title: capText(atomField(entry, 'title')),
    authors,
    doi: normDoi(doiMatch),
    published: atomField(entry, 'published') || null,
    venue: 'arXiv',
    summary: capText(atomField(entry, 'summary')),
    url: id,
  };
}

export function parseArxivAtom(xml) {
  const entries = [];
  const blocks = String(xml ?? '').match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const block of blocks) entries.push(trimArxivEntry(block));
  return entries;
}

async function fetchOpenAlex() {
  const upstream = await fetchJsonCapped(OPENALEX_URL, OPENALEX_HOST, null);
  const works = Array.isArray(upstream?.results) ? upstream.results : [];
  return works.map(trimOpenAlex).filter((w) => w.title);
}

async function fetchCrossref() {
  const upstream = await fetchJsonCapped(CROSSREF_URL, CROSSREF_HOST, null);
  const works = Array.isArray(upstream?.message?.items) ? upstream.message.items : [];
  return works.map(trimCrossref).filter((w) => w.title);
}

async function fetchPubMed() {
  const search = await fetchJsonCapped(PUBMED_ESEARCH_URL, PUBMED_HOST, null);
  const idlist = Array.isArray(search?.esearchresult?.idlist)
    ? search.esearchresult.idlist
    : [];
  if (!idlist.length) return [];
  const summary = await fetchJsonCapped(
    PUBMED_ESUMMARY_URL(encodeURIComponent(idlist.join(','))),
    PUBMED_HOST,
    null,
  );
  const result = summary?.result ?? {};
  return idlist
    .map((uid) => (result[String(uid)] ? trimPubMed(uid, result[String(uid)]) : null))
    .filter((w) => w && w.title);
}

async function fetchArxiv() {
  const xml = await fetchArxivAtom(ARXIV_URL);
  return parseArxivAtom(xml).filter((w) => w.title);
}

/**
 * Dedupe works across sources. Each item is indexed under BOTH its
 * normalized DOI key and its normalized title key, so a DOI-bearing
 * record still merges with a DOI-less duplicate sharing the title.
 * First occurrence (source priority: OpenAlex → Crossref → PubMed →
 * arXiv) keeps its record; the duplicate's feed is merged into
 * `alsoSeen`.
 */
export function dedupeWorks(lists) {
  const byDoi = new Map(); // doi → item
  const byTitle = new Map(); // normTitle → item
  const items = [];
  for (const list of lists) {
    for (const item of list) {
      const titleKey = `title:${normTitle(item.title)}`;
      const existing = (item.doi && byDoi.get(item.doi)) || byTitle.get(titleKey);
      if (existing) {
        if (existing.feed !== item.feed) {
          existing.alsoSeen = existing.alsoSeen ?? [];
          if (!existing.alsoSeen.includes(item.feed)) existing.alsoSeen.push(item.feed);
        }
        // Cross-register the survivor under the duplicate's other key so
        // later arrivals match through either identity.
        if (item.doi && !byDoi.has(item.doi)) byDoi.set(item.doi, existing);
        if (!byTitle.has(titleKey)) byTitle.set(titleKey, existing);
        continue;
      }
      const record = { ...item };
      items.push(record);
      if (record.doi) byDoi.set(record.doi, record);
      byTitle.set(titleKey, record);
    }
  }
  return items;
}

const SOURCES = [
  { name: 'openalex', fetch: fetchOpenAlex },
  { name: 'crossref', fetch: fetchCrossref },
  { name: 'pubmed', fetch: fetchPubMed },
  { name: 'arxiv', fetch: fetchArxiv },
];

export function trimResearchPayload(sourceResults) {
  const lists = [];
  const degradedSources = [];
  for (const { name, result } of sourceResults) {
    if (result instanceof Error) {
      degradedSources.push(name);
    } else {
      lists.push(result);
    }
  }
  const items = dedupeWorks(lists);
  return {
    generatedAt: new Date().toISOString(),
    count: items.length,
    items,
    degradedSources,
    source: 'OpenAlex + Crossref + PubMed + arXiv',
    attribution:
      'OpenAlex (CC0) · Crossref (open) · PubMed/NCBI (open) · arXiv (open)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.all(
      SOURCES.map(async ({ name, fetch }) => {
        try {
          return { name, result: await fetch() };
        } catch (error) {
          return { name, result: error instanceof Error ? error : new Error('unknown') };
        }
      }),
    )
      .then((sourceResults) => {
        const payload = trimResearchPayload(sourceResults);
        if (payload.degradedSources.length >= SOURCES.length)
          throw Object.assign(new Error('research_all_sources_unavailable'), { status: 502 });
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=1800') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the research ticker proxy. Mirrors the nwsAlerts provider shape. */
export function researchProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    req.on?.('close', () => {});
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      sendJson(res, error?.status === 502 ? 502 : 500, {
        error: 'research_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    } finally {
      req.removeListener?.('close', () => {});
    }
  }

  return {
    name: 'research',
    configureServer({ middlewares }) {
      middlewares.use('/api/research', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/research', handler);
    },
  };
}

export const _researchInternals = {
  normDoi,
  normTitle,
  parseArxivAtom,
  dedupeWorks,
  trimOpenAlex,
  trimCrossref,
  trimPubMed,
  trimArxivEntry,
  trimResearchPayload,
  clearCaches: () => { cache = null; inflight = null; arxivLastAt = 0; },
};
