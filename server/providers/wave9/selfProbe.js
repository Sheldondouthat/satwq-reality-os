/**
 * Wave 9 — Edge self-probe: honest-failure connectivity census from the edge.
 *
 * The honest-failures list (see the wave5 build receipt Post-D backlog) has
 * been probed from this VM 30 consecutive runs: several hosts answer 000
 * (raspberry-shake old hostname, acars.io, hfunderground, asas-sn Hawaii,
 * apis.is, data.ietf.org leap-seconds) — unverified from the edge, not
 * disproven. This route moves the probe INTO the Worker: it issues one GET
 * per host from the Cloudflare edge and returns per-host { code, finalUrl,
 * contentType, bytesRead, title, feedCandidate, verdict }. A 200 from the
 * edge turns "unverified" into verified-or-botwalled; a 000 from the edge
 * proves the failure is not VM-egress-specific.
 *
 * HONESTY: this is a connectivity census, NOT a feed-shape verification. A
 * 200 with a friendly content-type is labeled feedCandidate only as a
 * heuristic (JSON/XML-ish + non-HTML start); only a human reading the
 * payload shape decides whether a provider gets built. bot-wall verdicts
 * (403 / CAPTCHA challenge pages) mean a ToS-respecting skip — no header
 * spoofing, no challenge solving, no bypass. Results are a single
 * point-in-time snapshot; edge rate limits may differ from VM limits.
 * Nulls are never zero-filled (numOrNull guards Number('')===0).
 */
const USER_AGENT = 'satwq-reality-os/1.0 (+https://satwq-reality-os.pages.dev)';
const UPSTREAM_TIMEOUT_MS = 20000;
const SNIFF_CAP_BYTES = 8192;
const CACHE_TTL_MS = 6 * 3600 * 1000;
const STALE_MS = 7 * 24 * 3600 * 1000;
const RETRY_COOLDOWN_MS = 60 * 1000;
const CACHE_CONTROL = 'public, max-age=3600';

/**
 * The honest-failures list. Same URLs the VM probe pass hits (probes-*
 * dirs under the finish-all-my-work hidden_files), so VM vs edge results
 * are directly comparable.
 */
export const TARGETS = [
  { id: 'control', label: 'Raspberry Shake (current hostname) — sanity control', url: 'https://data.raspberryshake.org/fdsnws/station/1/version', expect: '200' },
  { id: 'acars', label: 'acars.io', url: 'https://acars.io/', expect: 'unknown' },
  { id: 'hfunderground', label: 'HF Underground', url: 'https://www.hfunderground.com/', expect: 'unknown' },
  { id: 'asas-sn', label: 'ASAS-SN Hawaii API', url: 'https://asas-sn.ifa.hawaii.edu/api/v2/', expect: 'unknown' },
  { id: 'apis-is', label: 'apis.is Iceland earthquakes', url: 'https://apis.is/earthquake/is', expect: 'unknown' },
  { id: 'leap-seconds', label: 'data.ietf.org leap-seconds.list', url: 'https://data.ietf.org/timezone/leap-seconds.list', expect: 'unknown' },
  { id: 'kiwisdr', label: 'KiwiSDR public map', url: 'https://kiwisdr.com/public/', expect: 'bot-wall' },
  { id: 'myshiptracking', label: 'MyShipTracking', url: 'https://www.myshiptracking.com/', expect: 'bot-wall' },
  { id: 'sailwx', label: 'SailWX (editorial blog control)', url: 'https://www.sailwx.com/', expect: '200-editorial' },
  { id: 'ioda', label: 'IODA documented /v3 path', url: 'https://api.ioda.inetintel.cc.gatech.edu/api/v3/signals/ucsd-nt/country/US', expect: '404' },
  { id: 'coastwatch-index', label: 'CoastWatch ERDDAP index (liveness control)', url: 'https://coastwatch.pfeg.noaa.gov/erddap/info/index.json', expect: '200' },
  { id: 'rs-stale-hostname', label: 'Raspberry Shake STALE hostname (expected dark)', url: 'https://fdsnws.raspberryshakedata.com/fdsnws/station/1/version', expect: 'unreachable' },
];

/** Markers that identify a bot-wall / challenge / editorial page inside a 200 body. */
const BOTWALL_MARKERS = /captcha|cf[- ]?challenge|attention required|just a moment|x-kiwi-auth|firewall|access denied|are you a robot/i;

/** Extract <title>…</title> from an HTML snippet (first 4KB), else null. */
export function extractTitle(snippet) {
  if (!snippet) return null;
  const m = /<title[^>]*>([\s\S]{1,200})<\/title>/i.exec(snippet.slice(0, 4096));
  if (!m) return null;
  const t = m[1].replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 120) : null;
}

/**
 * Classify one probe result. Pure function over { code, contentType,
 * finalUrl, bodyStart, error } -> { verdict, feedCandidate, botWall, note }.
 *
 * Verdicts: reachable | redirect-noted | bot-wall | not-found | rate-limited |
 * server-error | unreachable | other. feedCandidate is a HEURISTIC:
 * machine-looking content-type AND a non-HTML body start.
 */
export function classifyResult({ code, contentType = '', bodyStart = '', redirected = false, error = null }) {
  const ct = contentType.toLowerCase();
  const start = (bodyStart || '').trimStart();
  const isJsonish = ct.includes('json') || start.startsWith('{') || start.startsWith('[');
  const isXmlish = ct.includes('xml') && !ct.includes('html') || /^<(\?xml|rss|feed|urlset)/i.test(start);
  const isHtml = ct.includes('html') || /<!doctype html|<html/i.test(start.slice(0, 200));
  const botWall = code === 200 && isHtml && BOTWALL_MARKERS.test(start);
  const feedCandidate = code === 200 && !botWall && (isJsonish || isXmlish);
  let verdict;
  if (code === 0) verdict = 'unreachable';
  else if (code === 429) verdict = 'rate-limited';
  else if (code === 403) verdict = 'bot-wall';
  else if (code === 404) verdict = 'not-found';
  else if (code >= 500 && code <= 599) verdict = 'server-error';
  else if (code === 200 && botWall) verdict = 'bot-wall';
  else if (code === 200) verdict = 'reachable';
  else verdict = 'other';
  let note = null;
  if (code === 200 && botWall) note = 'HTTP 200 but body is a bot-wall / challenge / editorial page — ToS-respecting skip, no bypass attempted.';
  else if (code === 200 && isHtml && !feedCandidate) note = 'HTTP 200 HTML page — reachable, but no machine-readable feed detected (editorial / web-app surface).';
  else if (code === 200 && feedCandidate) note = 'HTTP 200 with machine-looking payload — candidate for a provider build; payload shape still needs human review.';
  else if (code === 0) note = `Unreachable from the edge: ${error ?? 'fetch failed'} — failure is not VM-egress-specific.`;
  else if (code === 404) note = 'Host reachable; the documented path is absent (API may have moved or retired).';
  if (redirected && (note == null)) note = 'Reached via redirect chain.';
  return { verdict, feedCandidate, botWall, note };
}

export function numOrNull(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return null; // empty cell = missing, never 0 (Number('')===0)
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** One probe: GET url with a 20s abort, capped sniff read. Returns a result row. */
export async function probeOne(target, fetchImpl = fetch) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetchImpl(target.url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    });
    const code = response.status;
    const headers = response.headers ?? {};
    const getHeader = typeof headers.get === 'function' ? (k) => headers.get(k) : () => null;
    const contentType = getHeader('content-type') ?? '';
    let bodyStart = '';
    let bytesRead = 0;
    try {
      const buffer = await response.arrayBuffer();
      bytesRead = buffer.byteLength;
      bodyStart = new TextDecoder().decode(buffer.slice(0, SNIFF_CAP_BYTES));
    } catch {
      // Body unreadable — classify on headers/code alone.
    }
    const classification = classifyResult({
      code,
      contentType,
      bodyStart,
      redirected: !!response.redirected,
      error: null,
    });
    return {
      id: target.id,
      label: target.label,
      url: target.url,
      code,
      ok: code === 200,
      finalUrl: response.url ?? target.url,
      redirected: !!response.redirected,
      contentType: contentType.split(';')[0].trim() || null,
      bytesRead,
      title: extractTitle(bodyStart),
      ...classification,
      priorVmVerdict: priorVmVerdict(target.id),
      at: new Date().toISOString(),
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    const classification = classifyResult({ code: 0, error: error?.message ?? 'fetch failed' });
    return {
      id: target.id,
      label: target.label,
      url: target.url,
      code: 0,
      ok: false,
      finalUrl: target.url,
      redirected: false,
      contentType: null,
      bytesRead: 0,
      title: null,
      ...classification,
      priorVmVerdict: priorVmVerdict(target.id),
      at: new Date().toISOString(),
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** What the VM probe pass recorded most recently for this host (context, not ground truth). */
export function priorVmVerdict(id) {
  switch (id) {
    case 'control': return 'vm:200 (revival holds)';
    case 'kiwisdr': return 'vm:https-000 / http-200-CAPTCHA-challenge';
    case 'myshiptracking': return 'vm:403-bot-wall (occasionally 000)';
    case 'sailwx': return 'vm:200-editorial-blog';
    case 'ioda': return 'vm:404 (host reachable, path absent)';
    case 'coastwatch-index': return 'vm:200 (followed 302)';
    case 'rs-stale-hostname': return 'vm:000 (stale hostname)';
    default: return 'vm:000 (30 consecutive runs)';
  }
}

export function buildPayload(rows, stale, scope) {
  const summary = { total: rows.length, reachable: 0, feedCandidates: 0, botWalls: 0, notFound: 0, unreachable: 0, rateLimited: 0, serverErrors: 0, edgeNewlyReachable: 0 };
  for (const r of rows) {
    if (r.verdict === 'reachable') summary.reachable += 1;
    if (r.verdict === 'bot-wall') summary.botWalls += 1;
    if (r.verdict === 'not-found') summary.notFound += 1;
    if (r.verdict === 'unreachable') summary.unreachable += 1;
    if (r.verdict === 'rate-limited') summary.rateLimited += 1;
    if (r.verdict === 'server-error') summary.serverErrors += 1;
    if (r.feedCandidate) summary.feedCandidates += 1;
    // The money metric: a host the VM could not reach (000) that the edge CAN.
    if (r.ok && String(r.priorVmVerdict ?? '').includes('vm:000')) summary.edgeNewlyReachable += 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    upstream: 'honest-failures list (see notes)',
    stale: !!stale,
    scope,
    summary,
    probes: rows,
    honesty: {
      census: 'Connectivity census only — a 200 is NOT proof of a machine-readable feed. feedCandidate is a content-type heuristic; payload shape still needs human review before any provider is built.',
      vmVsEdge: 'Hosts the VM reports as 000 may be VM-egress artifacts (egress-proxy per-host throttling observed 2026-09-27). An edge 000 here proves the failure is not VM-specific; an edge 200 turns "unverified from edge" into a real signal.',
      botWalls: 'bot-wall verdicts (403 / CAPTCHA challenge pages) are recorded, never bypassed — ToS-respecting skip, no header spoofing, no challenge solving.',
      pointInTime: 'Single point-in-time snapshot. Edge rate limits may differ from VM limits; re-probe before acting on any single result.',
      controls: 'control (data.raspberryshake.org) and coastwatch-index are expected-200 sanity checks; rs-stale-hostname is expected-unreachable. If the controls fail, read the whole census as edge-egress failure, not per-host failure.',
      attribution: 'Probed live from the Cloudflare edge by this route; no data fabricated.',
    },
  };
}

// --- fetch machinery / caches (wave9 conventions) ---

const payloadCache = new Map(); // key -> {at, payload}
const inflight = new Map();
let docFailedAt = -Infinity;

/**
 * Query parsing: ?target=all|<id> (default all).
 * Returns { targetId, badParam } — badParam set when a param is malformed.
 */
export function parseQuery(searchParams) {
  const raw = searchParams.get('target');
  const targetId = raw == null || raw === '' ? 'all' : raw;
  if (targetId === 'all') return { targetId };
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(targetId)) return { badParam: 'selfprobe_bad_target' };
  if (!TARGETS.some((t) => t.id === targetId)) return { requestedNotFound: true, targetId };
  return { targetId };
}

async function getPayload(targetId, fetchImpl = fetch) {
  const key = targetId;
  const now = Date.now();
  const hit = payloadCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return { payload: hit.payload, stale: false };
  let op = inflight.get(key);
  if (!op) {
    if (now - docFailedAt < RETRY_COOLDOWN_MS && hit && now - hit.at < STALE_MS) {
      return { payload: hit.payload, stale: true };
    }
    op = (async () => {
      try {
        const targets = targetId === 'all' ? TARGETS : TARGETS.filter((t) => t.id === targetId);
        // Parallel: 10-12 subrequests, all independent. Never sequential —
        // sequential × 20s timeouts would wall-time-bomb a Worker invocation.
        const rows = await Promise.allSettled(targets.map((t) => probeOne(t, fetchImpl))).then((settled) =>
          settled.map((s, i) => {
            if (s.status === 'fulfilled') return s.value;
            const t = targets[i];
            const classification = classifyResult({ code: 0, error: String(s.reason?.message ?? s.reason ?? 'unknown') });
            return {
              id: t.id, label: t.label, url: t.url, code: 0, ok: false,
              finalUrl: t.url, redirected: false, contentType: null, bytesRead: 0, title: null,
              ...classification, priorVmVerdict: priorVmVerdict(t.id),
              at: new Date().toISOString(), elapsedMs: null,
            };
          })
        );
        const payload = buildPayload(rows, false, { target: targetId });
        payloadCache.set(key, { at: Date.now(), payload });
        return { payload, stale: false };
      } catch (error) {
        docFailedAt = Date.now();
        if (hit && Date.now() - hit.at < STALE_MS) return { payload: hit.payload, stale: true };
        throw error;
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, op);
  }
  return op;
}

function sendJson(res, status, body, cacheControl = CACHE_CONTROL) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-9 edge self-probe proxy. */
export function selfProbeProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      const q = parseQuery(url.searchParams);
      if (q.badParam) return sendJson(res, 400, { error: q.badParam }, 'no-store');
      if (q.requestedNotFound) {
        return sendJson(res, 200, {
          generatedAt: new Date().toISOString(),
          scope: { target: q.targetId },
          requestedNotFound: true,
          knownTargets: TARGETS.map((t) => t.id),
        });
      }
      const { payload, stale } = await getPayload(q.targetId);
      sendJson(res, 200, stale ? { ...payload, stale: true } : payload);
    } catch (error) {
      const upstreamFail = error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'selfprobe_unavailable',
        detail: error?.message ?? 'unknown',
        honesty: { census: 'Connectivity census only — a 200 is NOT proof of a machine-readable feed.' },
      }, 'no-store');
    }
  }

  return {
    name: 'self-probe',
    configureServer({ middlewares }) {
      middlewares.use('/api/self-probe', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/self-probe', handler);
    },
  };
}

export const _selfProbeInternals = {
  TARGETS,
  CACHE_TTL_MS,
  classifyResult,
  extractTitle,
  probeOne,
  buildPayload,
  parseQuery,
  numOrNull,
  priorVmVerdict,
  resetCache: () => { payloadCache.clear(); inflight.clear(); docFailedAt = -Infinity; },
};
