/**
 * Wave 6 — RIPEstat internet-measurements proxy (keyless).
 *
 * RIPE NCC's stat API is free and keyless: country resource assignments,
 * ASN neighbour relationships, and BGP state lookups.
 *
 * Catalog #149–152:
 *   https://stat.ripe.net/data/country-resource-list
 *   https://stat.ripe.net/data/asn-neighbours
 *   https://stat.ripe.net/data/looking-glass
 *   https://stat.ripe.net/data/bgp-state
 *
 * Routes:
 *   GET /api/ripestat?country=US        → IPv4/IPv6/ASN assignments for the country
 *   GET /api/ripestat?asn=15169         → ASN neighbour summary (peers/upstreams/downstreams)
 *   GET /api/ripestat?prefix=1.1.1.0/24 → BGP state snapshot for a prefix
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const BASE = 'https://stat.ripe.net/data';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60_000;
const USER_AGENT = 'Gods Eye View (public internet-measurement context)';

let cache = new Map(); // modeKey -> {at, payload}
let inflight = new Map(); // modeKey -> promise

async function fetchJsonCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`ripestat_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('ripestat_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error?.status === 502) throw error;
    if (error instanceof SyntaxError)
      throw Object.assign(new Error('ripestat_upstream_bad_json'), {
        status: 502,
      });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sampleOf(list, n = 8) {
  return (Array.isArray(list) ? list : []).slice(0, n).map(String);
}

/** Defensive parse of country-resource-list `data.resources`. */
export function parseCountryResources(upstream) {
  const resources = upstream?.data?.resources ?? {};
  const ipv4 = Array.isArray(resources.ipv4) ? resources.ipv4 : [];
  const ipv6 = Array.isArray(resources.ipv6) ? resources.ipv6 : [];
  const asn = Array.isArray(resources.asn) ? resources.asn : [];
  return {
    ipv4Prefixes: ipv4.length,
    ipv6Prefixes: ipv6.length,
    asns: asn.length,
    sampleIpv4: sampleOf(ipv4),
    sampleIpv6: sampleOf(ipv6),
    sampleAsn: sampleOf(asn),
  };
}

/** Defensive parse of asn-neighbours `data.neighbours`. */
export function parseAsnNeighbours(upstream) {
  const neighbours = Array.isArray(upstream?.data?.neighbours)
    ? upstream.data.neighbours
    : [];
  const counts = { left: 0, right: 0, other: 0 };
  const top = [];
  for (const n of neighbours) {
    const asn = n?.asn;
    if (asn == null) continue;
    const type = String(n?.type ?? '').toLowerCase();
    if (type.includes('left')) counts.left += 1;
    else if (type.includes('right')) counts.right += 1;
    else counts.other += 1;
    top.push({
      asn: Number(asn),
      type: String(n?.type ?? 'unknown'),
      power: Number.isFinite(n?.power) ? n.power : null,
      v4Peers: Number.isFinite(n?.v4_peers) ? n.v4_peers : null,
      v6Peers: Number.isFinite(n?.v6_peers) ? n.v6_peers : null,
    });
  }
  top.sort((a, b) => (b.power ?? -1) - (a.power ?? -1));
  return { neighbourCount: neighbours.length, counts, top: top.slice(0, 25) };
}

/** Defensive parse of bgp-state `data.bgp_state`. */
export function parseBgpState(upstream) {
  const states = Array.isArray(upstream?.data?.bgp_state)
    ? upstream.data.bgp_state
    : [];
  const paths = [];
  const pathLengths = [];
  for (const s of states) {
    const path = Array.isArray(s?.path)
      ? s.path.map(Number).filter(Number.isFinite)
      : [];
    if (path.length) pathLengths.push(path.length);
    if (paths.length < 25) {
      paths.push({
        targetPrefix: String(s?.target_prefix ?? ''),
        path,
        sourceId: String(s?.source_id ?? ''),
        community: String(s?.community ?? ''),
        lastSeen: String(s?.last_seen ?? ''),
      });
    }
  }
  const origins = [
    ...new Set(
      states
        .map((s) => {
          const p = Array.isArray(s?.path) ? s.path : [];
          return p.length ? Number(p[p.length - 1]) : null;
        })
        .filter(Number.isFinite),
    ),
  ];
  return {
    routeCount: states.length,
    distinctOrigins: origins.slice(0, 10),
    avgPathLength: pathLengths.length
      ? Math.round(
          (pathLengths.reduce((a, b) => a + b, 0) / pathLengths.length) * 10,
        ) / 10
      : null,
    routes: paths,
  };
}

function modeKey(params) {
  if (params.asn) return `asn:${params.asn}`;
  if (params.prefix) return `prefix:${params.prefix}`;
  return `country:${params.country}`;
}

async function getSnapshot(params) {
  const key = modeKey(params);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.payload;
  if (!inflight.has(key)) {
    inflight.set(
      key,
      (async () => {
        let payload;
        if (params.asn) {
          const asn = String(params.asn).replace(/^AS/i, '');
          const url = `${BASE}/asn-neighbours?resource=AS${encodeURIComponent(asn)}`;
          payload = {
            generatedAt: new Date().toISOString(),
            mode: 'asn',
            asn: Number(asn),
            neighbours: parseAsnNeighbours(await fetchJsonCapped(url)),
            attribution: 'RIPE NCC RIPEstat (free, keyless)',
          };
        } else if (params.prefix) {
          const url = `${BASE}/bgp-state?resource=${encodeURIComponent(params.prefix)}`;
          payload = {
            generatedAt: new Date().toISOString(),
            mode: 'prefix',
            prefix: params.prefix,
            bgp: parseBgpState(await fetchJsonCapped(url)),
            attribution: 'RIPE NCC RIPEstat (free, keyless)',
          };
        } else {
          const country = /^[A-Za-z]{2}$/.test(params.country ?? '')
            ? params.country.toUpperCase()
            : 'US';
          const url = `${BASE}/country-resource-list?resource=${encodeURIComponent(country)}`;
          payload = {
            generatedAt: new Date().toISOString(),
            mode: 'country',
            country,
            resources: parseCountryResources(await fetchJsonCapped(url)),
            attribution: 'RIPE NCC RIPEstat (free, keyless)',
          };
        }
        cache.set(key, { at: Date.now(), payload });
        return payload;
      })().finally(() => {
        inflight.delete(key);
      }),
    );
  }
  return inflight.get(key);
}

function sendJson(res, status, body, cacheControl = 'public, max-age=900') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the RIPEstat proxy. Mirrors the wave-5 provider shape. */
export function ripestatProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const url = new URL(req.url ?? '/api/ripestat', 'http://localhost');
      const params = {
        country: url.searchParams.get('country') ?? undefined,
        asn: url.searchParams.get('asn') ?? undefined,
        prefix: url.searchParams.get('prefix') ?? undefined,
      };
      sendJson(res, 200, await getSnapshot(params));
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'ripestat_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'ripestat',
    configureServer({ middlewares }) {
      middlewares.use('/api/ripestat', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/ripestat', handler);
    },
  };
}

export const _ripestatInternals = {
  parseCountryResources,
  parseAsnNeighbours,
  parseBgpState,
  clearCaches: () => {
    cache = new Map();
    inflight = new Map();
  },
};
