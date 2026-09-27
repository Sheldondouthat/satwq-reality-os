/**
 * Wave 3 Track 2c / 2.11 — RIPEstat internet routing pulse.
 *
 * Polls the keyless RIPEstat Data API `bgp-state` endpoint for a curated set
 * of anycast DNS prefixes and distills, per RIS route collector (RRC), how
 * many peers see the prefix and with what path lengths. The frontend draws
 * "routing pulse" arcs between the RRC/IXP cities that observe each prefix.
 *
 * RIPEstat rate discipline: documented limit is 8 concurrent req/IP.
 * This provider never exceeds 4 in flight (mapLimit PREFIXES, 4).
 *
 * Keyless, no new dependencies, plain fetch + JSON (workerd-safe).
 * Follows the invisibleOceanProxy factory pattern.
 */
import {
  createKeylessProxy,
  fetchUpstreamText,
  mapLimit,
} from './lib/proxy.js';

const USER_AGENT =
  'SATWQ-RealityOS/1.0 (RIPEstat public BGP data; keyless; contact via repo)';
const ACCEPT = 'application/json';

// Curated anycast prefixes: globally visible from nearly every RIS collector,
// so the pulse arcs span the planet. Public, well-known anycast addresses.
const PREFIXES = ['1.1.1.0/24', '8.8.8.0/24', '9.9.9.0/24', '208.67.222.0/24'];

const CACHE_TTL_MS = 10 * 60_000; // BGP state moves slowly
const STALE_MS = 60 * 60_000;
const UPSTREAM_TIMEOUT_MS = 20_000;
const TEXT_CAP = 2 * 1024 * 1024;

function invalid(message) {
  return new Error(message || 'invalid_ripestat_data');
}

/**
 * Distill one bgp-state response into per-collector observations.
 * source_id looks like "00-102.208.105.2" -> RRC "rrc00".
 * Exported for unit tests.
 */
export function parseBgpState(doc) {
  const data = doc?.data;
  if (!data || !Array.isArray(data.bgp_state)) throw invalid('bgp_state_not_array');
  const collectors = {}; // rrc -> { peers, pathLens: [], samplePaths: [] }
  const originVotes = {};
  for (const entry of data.bgp_state) {
    const sid = String(entry?.source_id ?? '');
    const rrcNum = sid.split('-')[0];
    if (!/^\d{2}$/.test(rrcNum)) continue;
    const rrc = `rrc${rrcNum}`;
    const path = Array.isArray(entry.path) ? entry.path : [];
    const c = (collectors[rrc] ??= { peers: 0, pathLens: [], samplePaths: [] });
    c.peers += 1;
    if (path.length) {
      c.pathLens.push(path.length);
      const origin = path[path.length - 1];
      originVotes[origin] = (originVotes[origin] ?? 0) + 1;
      if (c.samplePaths.length < 3) c.samplePaths.push(path);
    }
  }
  let originAsn = null;
  let best = 0;
  for (const [asn, votes] of Object.entries(originVotes)) {
    if (votes > best) { best = votes; originAsn = Number(asn); }
  }
  const collectorList = Object.entries(collectors)
    .map(([rrc, c]) => ({
      rrc,
      peers: c.peers,
      avgPathLen: c.pathLens.length
        ? Math.round((c.pathLens.reduce((a, b) => a + b, 0) / c.pathLens.length) * 100) / 100
        : null,
      samplePaths: c.samplePaths,
    }))
    .sort((a, b) => b.peers - a.peers);
  return {
    prefix: data.resource ?? null,
    observedAt: data.timestamp ?? null,
    originAsn,
    totalPeers: collectorList.reduce((n, c) => n + c.peers, 0),
    collectors: collectorList,
  };
}

export function ripestatProxy({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  async function fetchUpstream({ fetchImpl: f, signal }) {
    return mapLimit(PREFIXES, 4, async (prefix) => {
      const url =
        `https://stat.ripe.net/data/bgp-state/data.json?resource=${encodeURIComponent(prefix)}`;
      const text = await fetchUpstreamText(f, url, {
        signal,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        textCap: TEXT_CAP,
        userAgent: USER_AGENT,
        accept: ACCEPT,
      });
      return parseBgpState(JSON.parse(text));
    });
  }

  function describe(payload, { stale = false, reason = null } = {}) {
    return {
      schemaVersion: 1,
      source: 'RIPEstat Data API (bgp-state) via local proxy',
      attribution:
        'BGP observations © RIPE NCC RIS route collectors; ' +
        'collector locations per RIPE NCC ris-docs. Served keyless, ≤4 concurrent req.',
      fetchedAt: payload?.fetchedAt ?? null,
      stale,
      unavailable: !payload,
      reason,
      prefixes: payload?.prefixes ?? [],
    };
  }

  // Stamp fetchedAt around the upstream sweep.
  const inner = fetchUpstream;
  async function wrapped(args) {
    const prefixes = await inner(args);
    return { fetchedAt: args.now(), prefixes };
  }

  return createKeylessProxy({
    name: 'ripestat',
    route: '/api/ripestat',
    ttlMs: CACHE_TTL_MS,
    staleMs: STALE_MS,
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    fetchUpstream: wrapped,
    describe,
    fetchImpl,
    now,
  });
}
