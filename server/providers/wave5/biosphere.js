/**
 * Wave 5 — Biosphere observations ticker proxy (keyless).
 *
 * Merges two biodiversity streams into one trimmed payload:
 *   #146 iNaturalist — recent observations (per-observation license)
 *   #147 GBIF        — recent occurrences (CC0/CC-BY)
 *
 * Both upstreams serve JSON but no browser CORS headers, so this proxy
 * trims each to the fields the globe/dock need (with lat/lon where the
 * record carries them) and caches the merge.
 *
 * Routes:
 *   GET /api/biosphere → {generatedAt, count, withCoords, items:[...], degradedSources:[], source, attribution}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'error' with pinned hosts, no node: imports, no WASM).
 */

const INAT_HOST = 'api.inaturalist.org';
const GBIF_HOST = 'api.gbif.org';

const INAT_URL = `https://${INAT_HOST}/v1/observations?per_page=10&order_by=created_at&order=desc`;
const GBIF_URL = `https://${GBIF_HOST}/v1/occurrence/search?limit=10`;

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60_000;
const TEXT_CAP = 200;
const USER_AGENT = 'Gods Eye View (public biodiversity context)';

let cache = null; // {at, payload}
let inflight = null;

function assertPinnedHost(url, host) {
  if (new URL(url).host !== host)
    throw Object.assign(new Error(`biosphere_unexpected_host_${host}`), { status: 502 });
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
      throw Object.assign(new Error(`biosphere_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('biosphere_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function capText(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + '…' : s;
}

function finiteCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function trimINatObservation(obs) {
  const taxon = obs?.taxon ?? {};
  // iNaturalist serializes location as "lat,lon"
  let lat = null;
  let lon = null;
  if (typeof obs?.location === 'string') {
    const [a, b] = obs.location.split(',').map((s) => Number.parseFloat(s));
    if (Number.isFinite(a) && Number.isFinite(b)) {
      lat = a;
      lon = b;
    }
  }
  const name =
    taxon?.preferred_common_name || obs?.species_guess || taxon?.name || 'Unknown organism';
  return {
    feed: 'inaturalist',
    id: String(obs?.id ?? ''),
    name: capText(name),
    scientificName: capText(taxon?.name),
    rank: String(taxon?.rank ?? ''),
    iconicTaxon: String(taxon?.iconic_taxon_name ?? ''),
    observed: obs?.observed_on ?? obs?.created_at ?? null,
    license: String(obs?.license_code ?? ''),
    lat,
    lon,
    observer: capText(obs?.user?.login),
    url: String(obs?.uri ?? ''),
  };
}

function trimGbifOccurrence(occ) {
  const name =
    occ?.scientificName || occ?.vernacularName || `${occ?.kingdom ?? 'Unknown'} sp.`;
  return {
    feed: 'gbif',
    id: String(occ?.key ?? ''),
    name: capText(name),
    scientificName: capText(occ?.scientificName),
    rank: String(occ?.taxonRank ?? ''),
    iconicTaxon: String(occ?.class ?? ''),
    observed: occ?.eventDate ?? null,
    license: String(occ?.license ?? ''),
    lat: finiteCoord(occ?.decimalLatitude),
    lon: finiteCoord(occ?.decimalLongitude),
    observer: capText(occ?.datasetName),
    url: occ?.key ? `https://www.gbif.org/occurrence/${occ.key}` : '',
  };
}

async function fetchINaturalist() {
  const upstream = await fetchJsonCapped(INAT_URL, INAT_HOST, null);
  const results = Array.isArray(upstream?.results) ? upstream.results : [];
  return results.map(trimINatObservation).filter((o) => o.id && o.name);
}

async function fetchGbif() {
  const upstream = await fetchJsonCapped(GBIF_URL, GBIF_HOST, null);
  const results = Array.isArray(upstream?.results) ? upstream.results : [];
  return results.map(trimGbifOccurrence).filter((o) => o.id && o.name);
}

const SOURCES = [
  { name: 'inaturalist', fetch: fetchINaturalist },
  { name: 'gbif', fetch: fetchGbif },
];

export function trimBiospherePayload(sourceResults) {
  const items = [];
  const degradedSources = [];
  for (const { name, result } of sourceResults) {
    if (result instanceof Error) {
      degradedSources.push(name);
    } else {
      items.push(...result);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    count: items.length,
    withCoords: items.filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon)).length,
    items,
    degradedSources,
    source: 'iNaturalist + GBIF occurrences',
    attribution:
      'iNaturalist (per-observation license) · GBIF (CC0/CC-BY)',
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
        const payload = trimBiospherePayload(sourceResults);
        if (payload.degradedSources.length >= SOURCES.length)
          throw Object.assign(new Error('biosphere_all_sources_unavailable'), { status: 502 });
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=900') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the biosphere ticker proxy. Mirrors the nwsAlerts provider shape. */
export function biosphereProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    req.on?.('close', () => {});
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      sendJson(res, error?.status === 502 ? 502 : 500, {
        error: 'biosphere_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    } finally {
      req.removeListener?.('close', () => {});
    }
  }

  return {
    name: 'biosphere',
    configureServer({ middlewares }) {
      middlewares.use('/api/biosphere', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/biosphere', handler);
    },
  };
}

export const _biosphereInternals = {
  trimINatObservation,
  trimGbifOccurrence,
  trimBiospherePayload,
  clearCaches: () => { cache = null; inflight = null; },
};
