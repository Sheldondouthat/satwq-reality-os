/**
 * Wave 6 — BirdCast live migration mosaics (keyless, no bytes proxied).
 *
 * Queries the public BirdCast S3 listing for today's mosaic prefix, picks
 * the newest mosaic JPEG, and returns its URL (the edge never proxies the
 * image bytes):
 *
 *   #145 https://is-birdcast-observed-prod.s3.us-east-1.amazonaws.com/
 *        ?list-type=2&prefix=mosaic/2026/09/27/&max-keys=50
 *        → S3 ListBucketResult XML → latest <Key> by <LastModified>
 *
 * If today's prefix is empty it falls back to yesterday's prefix.
 *
 * Routes:
 *   GET /api/birdcast → {generatedAt, date, count, latest:{key,url,lastModified}, attribution}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 *
 * Probe notes (2026-09-27, build VM): the S3 listing timed out from the
 * VM (curl 000 — VM-throttled, needs Worker probe); it was verified 200
 * by the feed-catalog survey earlier on 2026-09-27, and the provider is
 * written against the observed ListBucketResult shape.
 */

const S3_BASE = "https://is-birdcast-observed-prod.s3.us-east-1.amazonaws.com";
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 256 * 1024;
const CACHE_TTL_MS = 10 * 60_000; // mosaics refresh every 10 min
const USER_AGENT = "Gods Eye View (BirdCast mosaic index)";

let cache = null; // {at, payload}
let inflight = null;

function listingUrl(date) {
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${S3_BASE}/?list-type=2&prefix=mosaic/${yyyy}/${mm}/${dd}/&max-keys=50`;
}

/** Parse an S3 ListBucketResult XML into [{key, lastModified}] — regex only, no DOMParser at the edge. */
export function parseS3Listing(xml) {
  const text = String(xml ?? "");
  if (!/<ListBucketResult[\s>]/.test(text))
    throw new Error("birdcast_unexpected_listing");
  const out = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = /<Key>([^<]*)<\/Key>/.exec(m[1])?.[1];
    const lastModified = /<LastModified>([^<]*)<\/LastModified>/.exec(
      m[1],
    )?.[1];
    if (key && lastModified && Number.isFinite(Date.parse(lastModified))) {
      out.push({ key, lastModified });
    }
  }
  return out;
}

/** Newest entry by LastModified, or null when the prefix is empty. */
export function pickLatest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let best = entries[0];
  for (const e of entries) {
    if (Date.parse(e.lastModified) > Date.parse(best.lastModified)) best = e;
  }
  return {
    key: best.key,
    url: `${S3_BASE}/${best.key}`,
    lastModified: best.lastModified,
  };
}

async function fetchTextCapped(fetchImpl, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/xml, text/xml, */*",
      },
    });
    if (!response.ok)
      throw Object.assign(new Error(`birdcast_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error("birdcast_upstream_too_large"), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

async function getSnapshot(fetchImpl, nowMs) {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = (async () => {
      const today = new Date(nowMs);
      const yesterday = new Date(nowMs - 24 * 3600_000);
      let xml = await fetchTextCapped(fetchImpl, listingUrl(today));
      let entries = parseS3Listing(xml);
      let date = today;
      if (entries.length === 0) {
        xml = await fetchTextCapped(fetchImpl, listingUrl(yesterday));
        entries = parseS3Listing(xml);
        date = yesterday;
      }
      const latest = pickLatest(entries);
      if (!latest)
        throw Object.assign(new Error("birdcast_no_mosaics"), { status: 502 });
      const payload = {
        generatedAt: new Date().toISOString(),
        date: date.toISOString().slice(0, 10),
        count: entries.length,
        listingUrl: listingUrl(date),
        latest,
        attribution:
          "Migration mosaics: BirdCast, Cornell Lab of Ornithology. " +
          "Manifest only — image bytes are loaded client-side from the origin bucket.",
      };
      cache = { at: Date.now(), payload };
      return payload;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = "public, max-age=600") {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheControl,
  });
  res.end(JSON.stringify(body));
}

export function birdcastProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  async function handler(req, res) {
    if (req.method !== "GET")
      return sendJson(res, 405, { error: "method_not_allowed" }, "no-store");
    try {
      sendJson(res, 200, await getSnapshot(fetchImpl, now()));
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === "AbortError" ||
        /aborted?/i.test(error?.message ?? "");
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: "birdcast_unavailable",
          detail: error?.message ?? "unknown",
        },
        "no-store",
      );
    }
  }

  return {
    name: "birdcast",
    configureServer({ middlewares }) {
      middlewares.use("/api/birdcast", handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use("/api/birdcast", handler);
    },
  };
}

export const _birdcastInternals = {
  listingUrl,
  parseS3Listing,
  pickLatest,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
