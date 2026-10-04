/**
 * Wave 6 — knowledge ticker proxy: a rolling ticker of interesting facts (all keyless).
 *
 * Catalog #178–182:
 *   Wikimedia pageviews — https://wikimedia.org/api/rest_v1/metrics/pageviews/... (daily, open)
 *   World Bank         — https://api.worldbank.org/v2/country/US/indicator/SP.POP.TOTL (annual, CC-BY)
 *   Open Library       — https://openlibrary.org/search.json (live, open)
 *   MusicBrainz        — https://musicbrainz.org/ws/2/artist/ (live, CC0; 1 req/s, UA required)
 *   ClinicalTrials.gov — https://clinicaltrials.gov/api/v2/studies (live, US PD)
 *
 * Routes:
 *   GET /api/knowledge → {generatedAt, sources:{...}, items:[{id, kind, headline, detail, link}]}
 *
 * Each item is one self-contained fact card. Per-source failures are
 * recorded honestly in `sources.<key>.error`; a 502 is returned only when
 * EVERY source fails.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60_000;
const USER_AGENT = 'Gods Eye View (public knowledge-ticker context)';

let cache = null; // {at, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function formatInt(v) {
  const n = Number(v);
  return Number.isFinite(n)
    ? Math.round(n).toLocaleString('en-US')
    : String(v ?? 'unknown');
}

function utcDatePlusDays(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

async function fetchJsonCapped(url, tag, accept = 'application/json') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    });
    if (!response.ok)
      throw Object.assign(
        new Error(`knowledge_${tag}_upstream_${response.status}`),
        { status: 502 },
      );
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error(`knowledge_${tag}_upstream_too_large`), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error?.status === 502) throw error;
    if (error instanceof SyntaxError)
      throw Object.assign(new Error(`knowledge_${tag}_upstream_bad_json`), {
        status: 502,
      });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ——— source parsers (pure, exported for tests) ———

export function parseWikimediaPageviews(upstream, article = 'Earth') {
  const items = Array.isArray(upstream?.items) ? upstream.items : [];
  const views = items.reduce(
    (sum, i) => sum + (Number.isFinite(i?.views) ? i.views : 0),
    0,
  );
  if (!views) return [];
  return [
    {
      id: `wiki:pageviews:${article}`,
      kind: 'pageviews',
      headline: `"${article}" viewed ${formatInt(views)}× on Wikipedia (7 days)`,
      detail: `English Wikipedia daily pageviews, all access types, summed over the trailing 7 days.`,
      link: `https://en.wikipedia.org/wiki/${encodeURIComponent(article)}`,
    },
  ];
}

export function parseWorldBank(
  upstream,
  country = 'US',
  indicator = 'SP.POP.TOTL',
) {
  const rows = Array.isArray(upstream?.[1]) ? upstream[1] : [];
  const latest = rows.find((r) => r?.value != null);
  if (!latest) return [];
  return [
    {
      id: `worldbank:${country}:${indicator}`,
      kind: 'indicator',
      headline: `${country} population: ${formatInt(latest.value)} (${latest.date})`,
      detail: `World Bank indicator ${indicator}; annual series, latest available value.`,
      link: `https://data.worldbank.org/indicator/${indicator}`,
    },
  ];
}

export function parseOpenLibrary(upstream) {
  const docs = Array.isArray(upstream?.docs) ? upstream.docs : [];
  return docs.slice(0, 3).map((d, i) => ({
    id: `openlibrary:${d?.key ?? i}`,
    kind: 'books',
    headline: String(d?.title ?? 'Untitled'),
    detail: [
      Array.isArray(d?.author_name)
        ? `by ${d.author_name.slice(0, 3).join(', ')}`
        : null,
      d?.first_publish_year ? `first published ${d.first_publish_year}` : null,
      isFiniteNum(upstream?.numFound)
        ? `${formatInt(upstream.numFound)} matches for "solar wind"`
        : null,
    ]
      .filter(Boolean)
      .join(' · '),
    link: d?.key
      ? `https://openlibrary.org${d.key}`
      : 'https://openlibrary.org',
  }));
}

export function parseMusicBrainz(upstream) {
  const artists = Array.isArray(upstream?.artists) ? upstream.artists : [];
  return artists.slice(0, 2).map((a, i) => ({
    id: `musicbrainz:${a?.id ?? i}`,
    kind: 'music',
    headline: String(a?.name ?? 'Unknown artist'),
    detail: [
      a?.disambiguation ?? null,
      a?.['life-span']?.begin ? `active since ${a['life-span'].begin}` : null,
      a?.country ? `(${a.country})` : null,
    ]
      .filter(Boolean)
      .join(' '),
    link: a?.id
      ? `https://musicbrainz.org/artist/${a.id}`
      : 'https://musicbrainz.org',
  }));
}

export function parseClinicalTrials(upstream) {
  const studies = Array.isArray(upstream?.studies) ? upstream.studies : [];
  return studies.slice(0, 3).map((s, i) => {
    const idm = s?.protocolSection?.identificationModule ?? {};
    const stm = s?.protocolSection?.statusModule ?? {};
    return {
      id: `trials:${idm.nctId ?? i}`,
      kind: 'trials',
      headline: String(idm.briefTitle ?? 'Untitled study'),
      detail: [idm.nctId ?? null, stm.overallStatus ?? null]
        .filter(Boolean)
        .join(' · '),
      link: idm.nctId
        ? `https://clinicaltrials.gov/study/${idm.nctId}`
        : 'https://clinicaltrials.gov',
    };
  });
}

const SOURCES = [
  {
    key: 'wikimedia',
    attribution: 'Wikimedia REST API (open)',
    async fetch() {
      const end = utcDatePlusDays(-1);
      const start = utcDatePlusDays(-7);
      const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/Earth/daily/${start}/${end}`;
      return {
        items: parseWikimediaPageviews(await fetchJsonCapped(url, 'wikimedia')),
      };
    },
  },
  {
    key: 'worldbank',
    attribution: 'World Bank (CC-BY)',
    async fetch() {
      const url =
        'https://api.worldbank.org/v2/country/US/indicator/SP.POP.TOTL?format=json&per_page=2';
      return { items: parseWorldBank(await fetchJsonCapped(url, 'worldbank')) };
    },
  },
  {
    key: 'openlibrary',
    attribution: 'Open Library (open)',
    async fetch() {
      const url = 'https://openlibrary.org/search.json?q=solar+wind&limit=3';
      return {
        items: parseOpenLibrary(await fetchJsonCapped(url, 'openlibrary')),
      };
    },
  },
  {
    key: 'musicbrainz',
    attribution: 'MusicBrainz (CC0 data)',
    async fetch() {
      const url =
        'https://musicbrainz.org/ws/2/artist/?query=artist:radiohead&fmt=json&limit=2';
      return {
        items: parseMusicBrainz(await fetchJsonCapped(url, 'musicbrainz')),
      };
    },
  },
  {
    key: 'clinicaltrials',
    attribution: 'ClinicalTrials.gov (US public domain)',
    async fetch() {
      const url = 'https://clinicaltrials.gov/api/v2/studies?pageSize=3';
      return {
        items: parseClinicalTrials(
          await fetchJsonCapped(url, 'clinicaltrials'),
        ),
      };
    },
  },
];

async function fetchOneSource(source) {
  const started = Date.now();
  try {
    const { items } = await source.fetch();
    return {
      key: source.key,
      ok: true,
      count: items.length,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      items,
    };
  } catch (error) {
    return {
      key: source.key,
      ok: false,
      count: 0,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      items: [],
    };
  }
}

function buildSnapshot(results) {
  const sources = {};
  const items = [];
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      count: r.count,
      attribution: r.attribution,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
    items.push(...r.items);
  }
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: items.length,
    items,
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.all(SOURCES.map(fetchOneSource))
      .then((results) => {
        if (!results.some((r) => r.ok)) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(
            new Error(`knowledge_all_upstream_down: ${detail}`),
            { status: 502 },
          );
        }
        const payload = buildSnapshot(results);
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

/** Mount the knowledge ticker proxy. Mirrors the wave-5 quakes multi-source shape. */
export function knowledgeProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'knowledge_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'knowledge',
    configureServer({ middlewares }) {
      middlewares.use('/api/knowledge', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/knowledge', handler);
    },
  };
}

export const _knowledgeInternals = {
  parseWikimediaPageviews,
  parseWorldBank,
  parseOpenLibrary,
  parseMusicBrainz,
  parseClinicalTrials,
  buildSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
