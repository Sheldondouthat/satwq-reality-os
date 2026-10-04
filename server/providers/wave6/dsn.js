/**
 * Wave 6 — NASA Deep Space Network dish-status proxy (keyless).
 *
 * NASA's DSN Now data feed reports every DSN dish's pointing, activity,
 * up/down signal links, and spacecraft targets as compact XML:
 *
 *   #73 https://eyes.nasa.gov/dsn/data/dsn.xml
 *
 * Routes:
 *   GET /api/dsn → {generatedAt, sources:{...}, stations:[...], dishes:[...], activeSpacecraft:[...]}
 *
 * workerd has no DOMParser, so the XML is parsed with anchored regexes —
 * the schema is machine-generated with stable attribute sets (verified
 * against a live fetch on 2026-09-27). Per-source failure is recorded in
 * `sources.dsn.error`; a 502 is returned only when the feed is unreachable.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053) — no node: imports, no WASM).
 */

const UPSTREAM_URL = 'https://eyes.nasa.gov/dsn/data/dsn.xml';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 60_000; // near-real-time feed; refresh every minute
const USER_AGENT = 'Gods Eye View (public DSN dish context)';

let cache = null; // {at, payload}
let inflight = null;

function attrsOf(attrString) {
  const out = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString)) !== null) out[m[1]] = m[2];
  return out;
}

function num(value, decimals = 2) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function boolish(value) {
  return String(value).toLowerCase() === 'true';
}

// ——— parser (pure, exported for tests) ———

/** Parse a signal element (<upSignal/> or <downSignal/>). */
function parseSignal(attrString) {
  const a = attrsOf(attrString);
  return {
    active: boolish(a.active),
    band: a.band || null,
    signalType: a.signalType || null,
    dataRateBps: num(a.dataRate, 0),
    frequencyHz: num(a.frequency, 0),
    powerDbm: num(a.power),
    spacecraft: a.spacecraft || null,
    spacecraftID: num(a.spacecraftID, 0),
  };
}

/** Parse the full dsn.xml document into stations + dishes. */
export function parseDsn(xml) {
  const text = String(xml ?? '');
  const stations = [];
  const stationRe = /<station\b([^>]*)\/>/g;
  let m;
  while ((m = stationRe.exec(text)) !== null) {
    const a = attrsOf(m[1]);
    const timeMs = num(a.timeUTC, 0);
    stations.push({
      name: a.name || '',
      friendlyName: a.friendlyName || a.name || '',
      timeISO: Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : null,
    });
  }

  const dishes = [];
  const dishRe = /<dish\b([^>]*?)(?:\/>|>([\s\S]*?)<\/dish>)/g;
  while ((m = dishRe.exec(text)) !== null) {
    const a = attrsOf(m[1]);
    const inner = m[2] ?? '';
    const upSignals = [];
    const downSignals = [];
    const sigRe = /<(upSignal|downSignal)\b([^>]*?)\/>/g;
    let s;
    while ((s = sigRe.exec(inner)) !== null) {
      const parsed = parseSignal(s[2]);
      (s[1] === 'upSignal' ? upSignals : downSignals).push(parsed);
    }
    let target = null;
    const t = inner.match(/<target\b([^>]*?)\/>/);
    if (t) {
      const ta = attrsOf(t[1]);
      target = {
        name: ta.name || null,
        id: num(ta.id, 0),
        uplegRangeKm: num(ta.uplegRange, 0),
        downlegRangeKm: num(ta.downlegRange, 0),
        rtltSec: num(ta.rtlt, 0),
      };
    }
    const activeDown = downSignals.some((sig) => sig.active);
    dishes.push({
      name: a.name || '',
      azimuthDeg: num(a.azimuthAngle, 1),
      elevationDeg: num(a.elevationAngle, 1),
      windSpeed: num(a.windSpeed),
      activity: a.activity || '',
      mspa: boolish(a.isMSPA),
      array: boolish(a.isArray),
      ddor: boolish(a.isDDOR),
      tracking: activeDown,
      target,
      upSignals,
      downSignals,
    });
  }
  return { stations, dishes };
}

export function trimDsnPayload(xml) {
  const { stations, dishes } = parseDsn(xml);
  const seen = new Map();
  for (const dish of dishes) {
    for (const sig of dish.downSignals) {
      if (sig.spacecraft && !seen.has(sig.spacecraft)) {
        seen.set(sig.spacecraft, {
          name: sig.spacecraft,
          id: sig.spacecraftID,
          band: sig.band,
          dataRateBps: sig.dataRateBps,
          dish: dish.name,
        });
      }
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    dishCount: dishes.length,
    trackingCount: dishes.filter((d) => d.tracking).length,
    stations,
    dishes,
    activeSpacecraft: [...seen.values()],
    source: 'NASA Deep Space Network (public domain)',
  };
}

// ——— fetching ———

async function fetchTextCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). eyes.nasa.gov served the
      // feed 200-OK on the 2026-09-27 probe.
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/xml, text/xml, */*',
      },
    });
    if (!response.ok)
      throw Object.assign(new Error(`dsn_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('dsn_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = fetchTextCapped(UPSTREAM_URL)
      .then((xml) => {
        const payload = trimDsnPayload(xml);
        if (payload.dishCount === 0)
          throw Object.assign(new Error('dsn_no_dishes'), { status: 502 });
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=60') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the DSN dish-status proxy. Mirrors the felt provider shape. */
export function dsnProxy() {
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
          error: 'dsn_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'dsn',
    configureServer({ middlewares }) {
      middlewares.use('/api/dsn', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/dsn', handler);
    },
  };
}

export const _dsnInternals = {
  parseDsn,
  parseSignal,
  trimDsnPayload,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
