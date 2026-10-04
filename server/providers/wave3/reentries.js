/**
 * Reentry countdown provider — Track 3a item 3.4.
 *
 * TLE-decay analysis (honest, labeled prediction): scans CelesTrak GP groups
 * for objects with low perigee + positive drag (n-dot), extrapolates each to
 * the 150 km-circular mean-motion threshold, and returns candidates sorted by
 * predicted decay. The math lives in src/frontier/wave3/reentry/tleMath.js
 * (shared with the browser; no satellite.js here so the Pages Functions
 * bundle stays plain fetch+JSON).
 *
 * Routes:
 *   GET /api/reentries             → candidates, soonest first
 *   GET /api/reentries?maxDays=60  → prediction window (default 120)
 *   GET /api/reentries?limit=12    → max candidates (default 12, cap 30)
 *
 * W6 note: aerospace.org publishes a predicted-reentries table but exposes
 * no machine API (HTML only, dossier 2.18 UNVERIFIED). If W6 confirms a
 * machine path, merge it here keyed by NORAD id: keep the TLE model as the
 * fallback, prefer the aerospace predicted date when present, and record
 * `source: 'aerospace' | 'tle-decay-model'` per candidate. See INTEGRATION.md.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped reads,
 * no node: imports, no WASM, no `redirect:'error'`). CelesTrak etiquette:
 * descriptive User-Agent, 6h cache (they ask ≤1 GP pull per 2h), stale-serve
 * on upstream failure.
 */

import { readCappedResponseText } from '../common/http.js';
import {
  parseTleText,
  tleElements,
  predictDecay,
} from '../../../src/frontier/wave3/reentry/tleMath.js';

const GROUP_URL = (group) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
// Pre-computed snapshot (GitHub Actions, non-Cloudflare egress): CelesTrak
// throttles bulk TLE fetches from the edge, so the provider prefers this.
const SNAPSHOT_URL =
  'https://github.com/Sheldondouthat/satwq-reality-os/releases/download/reentries-latest/reentries.json';
const SNAPSHOT_TIMEOUT_MS = 20_000;
const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
// Debris-rich groups (VERIFIED live 2026-09-27 — "other" and "last-30-days"
// are not valid TLE groups: "other" → "Invalid query", "last-30-days" is
// CSV-only). These are the real breakup clouds (Iridium-33/Cosmos-2251
// collision, Fengyun-1C ASAT) plus the analyst set: the most likely
// reentry candidates. Per-group failure is tolerated.
const GROUPS = [
  'analyst',
  'cosmos-2251-debris',
  'fengyun-1c-debris',
  'iridium-33-debris',
];
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 6 * 3600_000;
const USER_AGENT =
  'SATWQ-Reality-OS/1.0 (keyless TLE decay analysis; contact: public repo)';
const HONESTY =
  'PREDICTION MODEL, not a forecast service: simple drag extrapolation from ' +
  'TLE mean-motion derivative to a 150 km circular threshold. Real reentry ' +
  'windows span hours to days and depend on solar activity and object ' +
  'attitude. Uncertainty envelope is ±max(0.5 d, 25% of prediction).';

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
    });
    if (!res.ok)
      throw Object.assign(new Error(`reentry_upstream_${res.status}`), {
        status: 502,
      });
    const { tooLarge, text } = await readCappedResponseText(
      res,
      BODY_CAP_BYTES,
    );
    if (tooLarge)
      throw Object.assign(new Error('reentry_upstream_too_large'), {
        status: 502,
      });
    if (!/^1 /m.test(text)) throw new Error('reentry_upstream_no_tle');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Mount the reentry-decay provider. */
export function reentriesProxy() {
  let cache = null; // { at, candidates }
  let inflight = null;

  async function getSnapshotCandidates() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
    try {
      const res = await fetch(SNAPSHOT_URL, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
      const { tooLarge, text } = await readCappedResponseText(
        res,
        SNAPSHOT_MAX_BYTES,
      );
      if (tooLarge) throw new Error('snapshot too large');
      const snap = JSON.parse(text);
      if (!Array.isArray(snap.candidates) || !snap.candidates.length)
        throw new Error('snapshot has no candidates');
      // Validate shape: every candidate must carry real TLE lines.
      for (const c of snap.candidates) {
        if (!/^1 \d{5}/.test(c.line1 || '') || !/^2 \d{5}/.test(c.line2 || ''))
          throw new Error('snapshot candidate TLE malformed');
      }
      return snap.candidates;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getCandidates(maxDays) {
    const nowMs = Date.now();
    if (cache && nowMs - cache.at < CACHE_TTL_MS && cache.maxDays === maxDays)
      return cache.candidates;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        // Prefer the pre-computed snapshot (reliable on the edge); fall back
        // to live CelesTrak fetch when the snapshot is missing or invalid.
        try {
          const snapCandidates = await getSnapshotCandidates();
          const filtered = snapCandidates.filter(
            (c) => c.daysToDecay <= maxDays,
          );
          cache = { at: Date.now(), maxDays, candidates: filtered };
          return filtered;
        } catch {
          /* snapshot unavailable — try live upstream */
        }
        const settled = await Promise.allSettled(
          GROUPS.map((g) => fetchText(GROUP_URL(g))),
        );
        let fulfilled = 0;
        const seen = new Set();
        const candidates = [];
        for (const result of settled) {
          if (result.status !== 'fulfilled') continue;
          fulfilled++;
          for (const set of parseTleText(result.value)) {
            const el = tleElements(set.line1, set.line2);
            if (!el || seen.has(el.noradId)) continue;
            seen.add(el.noradId);
            const pred = predictDecay(el, { maxDays });
            if (!pred) continue;
            candidates.push({
              noradId: el.noradId,
              name: set.name || `NORAD ${el.noradId}`,
              line1: set.line1,
              line2: set.line2,
              epochUtc: el.epochUtc,
              ...pred,
              perigeeKm: +pred.perigeeKm.toFixed(1),
              apogeeKm: +pred.apogeeKm.toFixed(1),
              daysToDecay: +pred.daysToDecay.toFixed(2),
              uncertaintyDays: +pred.uncertaintyDays.toFixed(2),
              meanMotion: +el.meanMotion.toFixed(4),
              ndot: el.ndot,
              bstar: el.bstar,
              source: 'tle-decay-model',
            });
          }
        }
        if (fulfilled === 0) throw new Error('reentry_upstream_all_failed');
        candidates.sort((a, b) =>
          a.predictedDecayUtc < b.predictedDecayUtc ? -1 : 1,
        );
        cache = { at: Date.now(), maxDays, candidates };
        return candidates;
      } catch (error) {
        if (cache) return cache.candidates;
        throw error;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 ? 'public, max-age=21600' : 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' });
    let maxDays = 120;
    let limit = 12;
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const md = parsed.searchParams.get('maxDays');
      const lim = parsed.searchParams.get('limit');
      if (md !== null)
        maxDays = Math.min(365, Math.max(1, Math.floor(Number(md) || 120)));
      if (lim !== null)
        limit = Math.min(30, Math.max(1, Math.floor(Number(lim) || 12)));
    } catch {
      return sendJson(res, 400, { error: 'reentries_bad_request' });
    }
    try {
      const candidates = (await getCandidates(maxDays)).slice(0, limit);
      sendJson(res, 200, {
        candidates,
        count: candidates.length,
        groups: GROUPS,
        fetchedAt: new Date(cache.at).toISOString(),
        model: 'tle-drag-extrapolation',
        honesty: HONESTY,
      });
    } catch {
      sendJson(res, 502, { error: 'reentries_upstream_unavailable' });
    }
  }

  return {
    name: 'reentries',
    configureServer({ middlewares }) {
      middlewares.use('/api/reentries', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/reentries', handler);
    },
  };
}
