/**
 * Wave 3 / Track 2a.4 — NOAA SWPC space-weather layer.
 *
 * WHY A PROXY: services.swpc.noaa.gov JSON is public domain and keyless,
 * but the provider normalizes the two feeds (1-minute planetary Kp +
 * alert products) into one small document at /api/space-weather, maps Kp
 * to the NOAA G-scale, and keeps a stale cache so the magnetosphere glow
 * never blinks out on a transient upstream failure.
 *
 * Upstream: https://services.swpc.noaa.gov/json/planetary_k_index_1m.json
 *           https://services.swpc.noaa.gov/products/alerts.json
 * (VERIFIED live 2026-09-27). Keyless. Global fetch only; no node:*
 * imports (Pages-safe).
 */
import { readResponseJsonCapped } from '../common/http.js';

const KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';
const ALERTS_URL = 'https://services.swpc.noaa.gov/products/alerts.json';
const USER_AGENT = 'satwq-reality-os/1.0 (NOAA SWPC public space weather; contact via repo)';

const CACHE_TTL_MS = 120_000; // Kp updates every minute
const STALE_MS = 30 * 60_000;
const RETRY_COOLDOWN_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
const JSON_CAP = 2 * 1024 * 1024;
const MAX_ALERTS = 12;

/** NOAA geomagnetic storm scale from Kp. */
export function kpToGScale(kp) {
  if (!Number.isFinite(kp)) return null;
  if (kp >= 9) return 'G5';
  if (kp >= 8) return 'G4';
  if (kp >= 7) return 'G3';
  if (kp >= 6) return 'G2';
  if (kp >= 5) return 'G1';
  return 'G0';
}

/** Take the latest entry of the 1-minute Kp feed. */
export function parseKpPayload(doc) {
  if (!Array.isArray(doc) || doc.length === 0) throw new Error('swpc_kp_unexpected_shape');
  const last = doc[doc.length - 1];
  const kp = Number(last?.kp_index);
  const estimated = Number(last?.estimated_kp);
  if (!Number.isFinite(kp)) throw new Error('swpc_kp_missing');
  return {
    kp,
    estimatedKp: Number.isFinite(estimated) ? estimated : null,
    timeTagMs: Date.parse(last?.time_tag),
    gScale: kpToGScale(kp),
  };
}

/** Keep recent alerts, newest first, with a one-line headline. */
export function parseAlertsPayload(doc, now = Date.now()) {
  if (!Array.isArray(doc)) throw new Error('swpc_alerts_unexpected_shape');
  const cutoff = now - 48 * 3600_000;
  return doc
    .map((a) => {
      const issueMs = Date.parse((a?.issue_datetime ?? '').replace(' ', 'T') + 'Z');
      const message = String(a?.message ?? '');
      const headline =
        message
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !/^(Space Weather Message Code|Serial Number):/i.test(l)) ??
        '';
      const codeMatch = message.match(/Space Weather Message Code:\s*([A-Z0-9]+)/);
      return {
        productId: a?.product_id ?? null,
        code: codeMatch ? codeMatch[1] : null,
        issueMs: Number.isFinite(issueMs) ? issueMs : null,
        headline: headline.trim().slice(0, 220),
      };
    })
    .filter((a) => a.issueMs != null && a.issueMs >= cutoff)
    .sort((a, b) => b.issueMs - a.issueMs)
    .slice(0, MAX_ALERTS);
}

function describe(value, { stale = false, reason = null } = {}) {
  return {
    schemaVersion: 1,
    source: 'NOAA SWPC via local proxy',
    attribution: 'Space weather data: NOAA Space Weather Prediction Center (public domain).',
    fetchedAt: value?.fetchedAt ?? null,
    stale,
    unavailable: !value,
    reason,
    kp: value?.kp ?? null,
    estimatedKp: value?.estimatedKp ?? null,
    timeTagMs: value?.timeTagMs ?? null,
    gScale: value?.gScale ?? null,
    alerts: value?.alerts ?? [],
  };
}

export function swpcProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  let cache = null; // { value, fetchedAt }
  let operation = null;
  let attemptedAt = -Infinity;

  async function upstreamJson(url, signal) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`swpc_upstream_http_${response.status}`);
    }
    const doc = await readResponseJsonCapped(response, JSON_CAP, signal);
    signal.throwIfAborted();
    return doc;
  }

  async function refresh(signal) {
    const [kpDoc, alertsDoc] = await Promise.all([
      upstreamJson(KP_URL, signal),
      upstreamJson(ALERTS_URL, signal).catch(() => []), // alerts are best-effort
    ]);
    signal.throwIfAborted();
    const kp = parseKpPayload(kpDoc);
    let alerts = [];
    try {
      alerts = parseAlertsPayload(alertsDoc, now());
    } catch {
      alerts = [];
    }
    const value = { ...kp, alerts, fetchedAt: now() };
    cache = { value, fetchedAt: now() };
    return { value, stale: false };
  }

  async function acquire(signal) {
    if (cache && now() - cache.fetchedAt < CACHE_TTL_MS) {
      return { value: cache.value, stale: false };
    }
    signal.throwIfAborted();
    if (!operation) {
      if (now() - attemptedAt < RETRY_COOLDOWN_MS) throw new Error('swpc_retry_later');
      attemptedAt = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);
      operation = refresh(controller.signal).finally(() => {
        clearTimeout(timer);
        operation = null;
      });
    }
    const cancelled = new Promise((_, reject) => {
      const abort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      const detach = () => signal.removeEventListener('abort', abort);
      operation.then(detach, detach); // both branches resolve: never an unhandled rejection
    });
    return Promise.race([operation, cancelled]);
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
      try {
        const { value, stale } = await acquire(controller.signal);
        json(200, describe(value, { stale }));
      } catch (error) {
        const usable = cache && now() - cache.fetchedAt <= STALE_MS;
        json(
          200,
          usable
            ? describe(cache.value, { stale: true, reason: 'SWPC unreachable; showing last reading.' })
            : describe(null, { reason: 'NOAA SWPC unreachable and no cached reading exists.' }),
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'swpc',
    configureServer({ middlewares }) {
      middlewares.use('/api/space-weather', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/space-weather', handler);
    },
  };
}
