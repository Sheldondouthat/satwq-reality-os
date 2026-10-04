/**
 * Wave 3 / Track 3b — Orcasound hydrophone provider (keyless).
 *
 * Upstream: https://live.orcasound.net/listen — the page embeds
 * __NEXT_DATA__ with the hydrophone registry
 * (props.pageProps.dehydratedState.queries[].state.data.feeds[]).
 * The Next build ID is NOT hardcoded; the page is re-parsed on refresh.
 *
 * Per-node live HLS: https://{bucket}.s3.amazonaws.com/{nodeName}/latest.txt
 * gives the current timestamp; the playlist is then
 * https://{bucket}.s3.amazonaws.com/{nodeName}/hls/{ts}/live.m3u8.
 * The bucket sends Access-Control-Allow-Origin: * (verified 2026-09-27),
 * so browsers can play the playlist + segments directly — no proxy needed.
 */

export const ORCASOUND_ROUTE = '/api/orcasound';

const LISTEN_URL = 'https://live.orcasound.net/listen';
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 512 * 1024;
const CACHE_TTL_MS = 60_000; // registry changes rarely; latest.txt is per-play
const USER_AGENT =
  'SATWQ-Reality-OS/1.0 (keyless Orcasound hydrophone context; contact: public repo)';

const HONESTY =
  'Hydrophone registry and live HLS playlists come from Orcasound ' +
  '(live.orcasound.net, S3 bucket audio-orcasound-net). Audio is the live ' +
  'hydrophone stream, unmodified. Detection of orca calls is left to the ' +
  'listener — this provider makes no call-detection claims.';

/** Extract the __NEXT_DATA__ JSON from the /listen HTML. */
export function parseNextData(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s,
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Pull the feeds array out of the Next dehydrated state. Pure. */
export function extractFeeds(nextData) {
  try {
    const queries = nextData?.props?.pageProps?.dehydratedState?.queries ?? [];
    for (const q of queries) {
      const feeds = q?.state?.data?.feeds;
      if (Array.isArray(feeds) && feeds.length) return feeds;
    }
  } catch {
    /* fall through */
  }
  return [];
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normalize one feed into the public document shape. Pure. */
export function normalizeFeed(f) {
  if (!f || typeof f !== 'object') return null;
  const nodeName = String(f.nodeName ?? '').trim();
  const name = String(f.name ?? '').trim();
  if (!nodeName || !name) return null;
  const lat = numOrNull(f.latLng?.lat);
  const lon = numOrNull(f.latLng?.lng);
  if (
    lat === null ||
    lon === null ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return null;
  }
  const bucket = String(f.bucket || 'audio-orcasound-net').trim();
  return {
    name,
    nodeName,
    slug: String(f.slug ?? '').trim() || null,
    lat,
    lon,
    online: f.online === true,
    thumbUrl: typeof f.thumbUrl === 'string' ? f.thumbUrl : null,
    // Resolved at serve time via latest.txt (see below); template kept for reference.
    latestTxtUrl: `https://${bucket}.s3.amazonaws.com/${nodeName}/latest.txt`,
    playlistTemplate: `https://${bucket}.s3.amazonaws.com/${nodeName}/hls/{ts}/live.m3u8`,
  };
}

export function describeOrcasound({ feeds, fetchedAt }) {
  return {
    schemaVersion: 1,
    source: 'Orcasound (live.orcasound.net)',
    attribution:
      'Hydrophones: Orcasound community network — audio streamed live, unmodified',
    fetchedAt,
    stale: false,
    unavailable: false,
    reason: null,
    honesty: HONESTY,
    count: feeds.length,
    onlineCount: feeds.filter((f) => f.online).length,
    hydrophones: feeds,
  };
}

export function orcasoundProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  ttlMs = CACHE_TTL_MS,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  let mem = null;
  let inflight = null;

  async function fetchText(url, accept) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Orcasound HTTP ${res.status} for ${url}`);
      const text = await res.text();
      if (text.length > BODY_CAP_BYTES)
        throw new Error('Orcasound payload exceeds cap');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolve latest.txt -> playlist URL for one node. Null when offline/stale. */
  async function resolvePlaylist(feed) {
    try {
      const ts = (await fetchText(feed.latestTxtUrl, 'text/plain')).trim();
      if (!/^\d{6,}$/.test(ts)) return null;
      return feed.playlistTemplate.replace('{ts}', ts);
    } catch {
      return null;
    }
  }

  async function refreshUpstream() {
    const html = await fetchText(LISTEN_URL, 'text/html');
    const nextData = parseNextData(html);
    if (!nextData)
      throw new Error('__NEXT_DATA__ not found on Orcasound /listen');
    const feeds = extractFeeds(nextData).map(normalizeFeed).filter(Boolean);
    if (!feeds.length) throw new Error('no hydrophone feeds in __NEXT_DATA__');
    // Resolve playlists for online feeds (best-effort, parallel).
    const withStreams = await Promise.all(
      feeds.map(async (f) => {
        const hlsUrl = f.online ? await resolvePlaylist(f) : null;
        return { ...f, hlsUrl, streamLive: hlsUrl !== null };
      }),
    );
    return { at: Date.now(), feeds: withStreams };
  }

  function refreshSingleFlight() {
    if (!inflight) {
      inflight = refreshUpstream().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  const installMiddleware = (server) => {
    server.middlewares.use(ORCASOUND_ROUTE, async (req, res) => {
      const sendJson = (status, bodyObj) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bodyObj));
      };
      try {
        if (req.method !== 'GET') {
          sendJson(405, { error: 'method_not_allowed' });
          return;
        }
        const now = Date.now();
        if (!mem || now - mem.at > ttlMs) {
          try {
            mem = await refreshSingleFlight();
          } catch (err) {
            console.warn(
              '[orcasound-proxy] upstream failed:',
              err?.message || err,
            );
            if (!mem) {
              sendJson(503, {
                error: 'orcasound_unavailable',
                honesty: HONESTY,
              });
              return;
            }
            mem = { ...mem, stale: true };
          }
        }
        const doc = describeOrcasound({
          feeds: mem.feeds,
          fetchedAt: new Date(mem.at).toISOString(),
        });
        if (mem.stale) {
          doc.stale = true;
          doc.reason = 'Upstream unreachable; showing last good registry.';
        }
        sendJson(200, doc);
      } catch {
        sendJson(500, { error: 'orcasound proxy error' });
      }
    });
  };

  return {
    name: 'orcasound-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
