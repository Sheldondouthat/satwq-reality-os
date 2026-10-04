/**
 * EiBi + WSPR shortwave oracle — Track 3b item 3.9 ("MUF / listenability").
 *
 * A heuristic propagation oracle, not a measurement. It composes three
 * already-cached sibling APIs plus two tiny SWPC JSON feeds:
 *   - /api/eibi               → broadcast stations currently on-air (scheduled)
 *   - /api/invisible-ocean/spots → recent WSPR/PSK spots (MEASURED activity)
 *   - SWPC 10cm flux + 1-min Kp (keyless, direct)
 *
 * Sibling APIs are fetched same-origin (derived from the request Host), so
 * no upstream is scraped twice and no other worker's module is imported.
 * Every component degrades independently: if a sibling is down, its
 * contribution reads "unknown" instead of failing the document.
 *
 * The oracle model (all outputs labeled model/heuristic):
 *   MUF ≈ 3.3 × foF2,  foF2(day) ≈ 2.2 + 0.026 × F10.7 MHz (rough empirical
 *   fit), foF2(night) ≈ 0.5 × day. Per-band listenability blends measured
 *   WSPR activity (50%), scheduled EiBi density (20%) and a solar/day-night
 *   heuristic (30%). It is NOT measured reception.
 *
 * Routes:
 *   GET /api/shortwave-oracle → oracle document (HTTP 200, soft-degrade)
 *
 * No WASM, no node: imports — Pages-safe.
 *
 * @returns {import('vite').Plugin}
 */

export const SHORTWAVE_ROUTE = '/api/shortwave-oracle';

const EIBI_ROUTE = '/api/eibi';
const SPOTS_ROUTE = '/api/invisible-ocean/spots';
const FLUX_URL =
  'https://services.swpc.noaa.gov/products/summary/10cm-flux.json';
const KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';

const CACHE_TTL_MS = 5 * 60_000;
const UPSTREAM_TIMEOUT_MS = 12_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const USER_AGENT =
  'SATWQ-Reality-OS/1.0 (keyless shortwave propagation context; contact: public repo)';

const HONESTY =
  'Listenability scores are a HEURISTIC MODEL blending measured WSPR spot ' +
  'activity, scheduled EiBi broadcasts, and a rough solar/day-night rule. ' +
  'They are not measured reception at your location. MUF is a rough ' +
  'empirical estimate (foF2 ≈ 2.2 + 0.026×F10.7, M-factor 3.3), not an ' +
  'ionosonde reading.';

/** HF bands: ham segments for WSPR spots, broadcast segments for EiBi. */
export const HAM_BANDS = Object.freeze([
  { name: '160m', lo: 1.8, hi: 2.0 },
  { name: '80m', lo: 3.5, hi: 4.0 },
  { name: '60m', lo: 5.3, hi: 5.41 },
  { name: '40m', lo: 7.0, hi: 7.3 },
  { name: '30m', lo: 10.1, hi: 10.15 },
  { name: '20m', lo: 14.0, hi: 14.35 },
  { name: '17m', lo: 18.068, hi: 18.168 },
  { name: '15m', lo: 21.0, hi: 21.45 },
  { name: '12m', lo: 24.89, hi: 24.99 },
  { name: '10m', lo: 28.0, hi: 29.7 },
]);

export const BROADCAST_BANDS = Object.freeze([
  { name: '120m', lo: 2.3, hi: 2.495 },
  { name: '90m', lo: 3.2, hi: 3.4 },
  { name: '75m', lo: 3.9, hi: 4.0 },
  { name: '60m', lo: 4.75, hi: 5.06 },
  { name: '49m', lo: 5.9, hi: 6.2 },
  { name: '41m', lo: 7.1, hi: 7.6 },
  { name: '31m', lo: 9.4, hi: 9.99 },
  { name: '25m', lo: 11.6, hi: 12.1 },
  { name: '22m', lo: 13.57, hi: 13.87 },
  { name: '19m', lo: 15.1, hi: 15.8 },
  { name: '16m', lo: 17.48, hi: 17.9 },
  { name: '13m', lo: 21.45, hi: 21.85 },
  { name: '11m', lo: 25.6, hi: 26.1 },
]);

/** Union of bands for the oracle table, ordered low→high frequency. */
export const ORACLE_BANDS = Object.freeze(
  [
    ...HAM_BANDS.map((b) => ({ ...b, kind: 'ham' })),
    ...BROADCAST_BANDS.filter(
      (b) => !HAM_BANDS.some((h) => h.name === b.name),
    ).map((b) => ({ ...b, kind: 'broadcast' })),
  ]
    .map((b) => ({ ...b, centerMhz: (b.lo + b.hi) / 2 }))
    .sort((a, b) => a.lo - b.lo),
);

/** Band name for a frequency in MHz, or null. `table` selects ham vs broadcast. */
export function bandForMhz(freqMhz, table = HAM_BANDS) {
  const f = Number(freqMhz);
  if (!Number.isFinite(f) || f <= 0) return null;
  const hit = table.find((b) => f >= b.lo && f <= b.hi);
  return hit ? hit.name : null;
}

/**
 * Rough empirical MUF estimate (MODEL).
 * foF2(day) ≈ 2.2 + 0.026 × F10.7 MHz; night ≈ half; MUF(3000) ≈ 3.3 × foF2.
 * Returns nulls when flux is unknown.
 */
export function mufEstimate(flux) {
  const f = Number(flux);
  if (!Number.isFinite(f) || f <= 0) {
    return {
      dayMufMhz: null,
      nightMufMhz: null,
      model: 'foF2≈2.2+0.026×F10.7, M=3.3',
    };
  }
  const foF2Day = 2.2 + 0.026 * f;
  const round1 = (v) => Math.round(v * 10) / 10;
  return {
    dayMufMhz: round1(3.3 * foF2Day),
    nightMufMhz: round1(3.3 * foF2Day * 0.5),
    model: 'foF2≈2.2+0.026×F10.7, M=3.3',
  };
}

/** Crude day/night: bands ≥10 MHz need daylight; <10 MHz prefer night. */
export function dayNightFactor(centerMhz, hourUtc) {
  // Solar noon ≈ 12 UTC over the Atlantic reference; this is a GLOBAL
  // heuristic, not a path computation — labeled as such.
  const dayness = Math.cos(((hourUtc - 12) / 24) * 2 * Math.PI) * 0.5 + 0.5; // 0..1
  if (centerMhz >= 10) return 0.35 + 0.65 * dayness;
  return 1 - 0.5 * dayness;
}

/** Kp penalty: geomagnetic storms depress HF (heuristic). */
export function kpPenalty(kp) {
  const k = Number(kp);
  if (!Number.isFinite(k)) return 1;
  if (k >= 7) return 0.25;
  if (k >= 5) return 0.45;
  if (k >= 4) return 0.7;
  return 1;
}

/**
 * Per-band listenability 0..100 (MODEL). Components:
 *   measured  (50%): recent WSPR spots on the band (count + median SNR)
 *   scheduled (20%): EiBi stations currently on-air in the band
 *   sky       (30%): day/night × Kp heuristic
 * Returns null when there is no data at all for the band.
 */
export function scoreBand({
  band,
  wsprCount,
  wsprMedianSnr,
  eibiCount,
  kp,
  hourUtc,
}) {
  const hasData = Number.isFinite(wsprCount) || Number.isFinite(eibiCount);
  if (!hasData) return null;
  const count = Number.isFinite(wsprCount) ? wsprCount : 0;
  const snr = Number.isFinite(wsprMedianSnr) ? wsprMedianSnr : null;
  const measured =
    Math.min(1, count / 25) * 0.6 +
    (snr === null ? 0 : Math.max(0, Math.min(1, (snr + 25) / 30)) * 0.4);
  const scheduled = Math.min(
    1,
    (Number.isFinite(eibiCount) ? eibiCount : 0) / 40,
  );
  const sky = dayNightFactor(band.centerMhz, hourUtc) * kpPenalty(kp);
  const score = Math.round(
    100 * (0.5 * measured + 0.2 * scheduled + 0.3 * sky),
  );
  return {
    score,
    components: {
      measured: Math.round(measured * 100) / 100,
      scheduled: Math.round(scheduled * 100) / 100,
      sky: Math.round(sky * 100) / 100,
    },
  };
}

export function verdictFor(score) {
  if (score === null || score === undefined) return 'no data';
  if (score >= 70) return 'wide open (model)';
  if (score >= 40) return 'fair (model)';
  if (score >= 10) return 'poor (model)';
  return 'closed (model)';
}

/**
 * Build the oracle document from raw inputs. All inputs optional —
 * missing pieces degrade to "unknown" rather than failing.
 */
export function buildOracle({
  eibiOnAir = [],
  spots = [],
  flux = null,
  kp = null,
  nowMs = Date.now(),
} = {}) {
  const hourUtc =
    new Date(nowMs).getUTCHours() + new Date(nowMs).getUTCMinutes() / 60;
  // null-safe numeric coercion: Number(null) === 0 would fabricate solar data
  const numOrNull = (v) =>
    v === null || v === undefined || v === '' || !Number.isFinite(Number(v))
      ? null
      : Number(v);
  const fluxNum = numOrNull(flux);
  const kpNum = numOrNull(kp);

  // WSPR: per-band counts + median SNR, last 30 min only
  const cutoff = nowMs - 30 * 60_000;
  const wsprByBand = new Map();
  for (const s of spots) {
    if (!s || s.timeMs < cutoff) continue;
    const band = s.band || bandForMhz(s.freqHz / 1e6, HAM_BANDS);
    if (!band) continue;
    if (!wsprByBand.has(band)) wsprByBand.set(band, []);
    wsprByBand.get(band).push(Number(s.snrDb));
  }
  const wsprStats = new Map();
  for (const [band, snrs] of wsprByBand) {
    const finite = snrs.filter(Number.isFinite).sort((a, b) => a - b);
    wsprStats.set(band, {
      count: snrs.length,
      medianSnr: finite.length ? finite[Math.floor(finite.length / 2)] : null,
    });
  }

  // EiBi: per-band on-air counts (broadcast table)
  const eibiByBand = new Map();
  const eibiExamples = new Map();
  for (const e of eibiOnAir) {
    const band = bandForMhz(Number(e.freqKhz) / 1000, BROADCAST_BANDS);
    if (!band) continue;
    eibiByBand.set(band, (eibiByBand.get(band) ?? 0) + 1);
    if (!eibiExamples.has(band) && e.station) {
      eibiExamples.set(band, String(e.station).slice(0, 60));
    }
  }

  const bands = ORACLE_BANDS.map((band) => {
    const ws = wsprStats.get(band.name);
    // broadcast bands have no WSPR beacons; ham bands have no EiBi schedule —
    // cross-map by frequency overlap for a fuller picture.
    const overlapWs = ws ?? nearestWsprStats(band, wsprStats);
    const eibiCount = eibiByBand.get(band.name) ?? null;
    const scored = scoreBand({
      band,
      wsprCount: overlapWs?.count ?? null,
      wsprMedianSnr: overlapWs?.medianSnr ?? null,
      eibiCount,
      kp: kpNum,
      hourUtc,
    });
    return {
      band: band.name,
      kind: band.kind,
      rangeMhz: [band.lo, band.hi],
      wsprSpots30m: overlapWs?.count ?? 0,
      wsprMedianSnrDb: overlapWs?.medianSnr ?? null,
      eibiOnAir: eibiCount ?? 0,
      eibiExample: eibiExamples.get(band.name) ?? null,
      score: scored?.score ?? null,
      components: scored?.components ?? null,
      verdict: verdictFor(scored?.score ?? null),
    };
  });

  const scored = bands.filter((b) => b.score !== null);
  const best = scored.length
    ? scored.reduce((a, b) => (b.score > a.score ? b : a))
    : null;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    solar: {
      flux10cm: fluxNum,
      kp: kpNum,
    },
    muf: mufEstimate(fluxNum),
    bands,
    bestBand: best
      ? { band: best.band, score: best.score, verdict: best.verdict }
      : null,
    sources: {
      eibiOnAir: eibiOnAir.length,
      wsprSpots30m: [...wsprByBand.values()].reduce((a, v) => a + v.length, 0),
    },
    honesty: HONESTY,
  };
}

/** WSPR stats from the nearest ham band (for broadcast rows' context). */
function nearestWsprStats(band, wsprStats) {
  let best = null;
  let bestDist = Infinity;
  for (const hb of HAM_BANDS) {
    const st = wsprStats.get(hb.name);
    if (!st) continue;
    const dist = Math.abs((hb.lo + hb.hi) / 2 - band.centerMhz);
    if (dist < bestDist) {
      bestDist = dist;
      best = st;
    }
  }
  return bestDist <= 4 ? best : null; // only within 4 MHz — else no data
}

async function fetchJson(url, fetchImpl, signal, cap = BODY_CAP_BYTES) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  if (text.length > cap) throw new Error('payload exceeds cap');
  return JSON.parse(text);
}

function originFromReq(req) {
  const host = req.headers?.host || req.headers?.[':authority'];
  if (!host || typeof host !== 'string') return null;
  const forwarded = req.headers?.['x-forwarded-proto'];
  const proto =
    typeof forwarded === 'string' && forwarded.includes('https')
      ? 'https'
      : /^localhost(:|$)|^127\.|^192\.168\.|^10\./.test(host)
        ? 'http'
        : 'https';
  return `${proto}://${host}`;
}

export function shortwaveOracleProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  ttlMs = CACHE_TTL_MS,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  let mem = null;
  let inflight = null;

  async function refreshUpstream(origin) {
    const timed = (p) => {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), timeoutMs);
      return {
        signal: c.signal,
        done: () => clearTimeout(t),
        promise: p(c.signal),
      };
    };
    const jobs = [];
    // Sibling APIs (already cached by their owners) — degrade independently.
    if (origin) {
      jobs.push([
        'eibi',
        timed((s) => fetchJson(`${origin}${EIBI_ROUTE}`, fetchImpl, s)),
      ]);
      jobs.push([
        'spots',
        timed((s) => fetchJson(`${origin}${SPOTS_ROUTE}`, fetchImpl, s)),
      ]);
    }
    jobs.push(['flux', timed((s) => fetchJson(FLUX_URL, fetchImpl, s))]);
    jobs.push(['kp', timed((s) => fetchJson(KP_URL, fetchImpl, s))]);

    const out = {};
    await Promise.all(
      jobs.map(async ([name, job]) => {
        try {
          out[name] = { ok: true, data: await job.promise };
        } catch (err) {
          out[name] = { ok: false, error: err?.message || 'fetch failed' };
        } finally {
          job.done();
        }
      }),
    );

    const eibiOnAir = out.eibi?.ok ? (out.eibi.data?.onAir ?? []) : [];
    const spots = out.spots?.ok ? (out.spots.data?.spots ?? []) : [];
    const fluxDoc = out.flux?.ok ? out.flux.data : null;
    const flux =
      Array.isArray(fluxDoc) && fluxDoc.length
        ? Number(fluxDoc[fluxDoc.length - 1]?.flux)
        : null;
    const kpDoc = out.kp?.ok ? out.kp.data : null;
    const kp =
      Array.isArray(kpDoc) && kpDoc.length
        ? Number(kpDoc[kpDoc.length - 1]?.kp_index)
        : null;

    return {
      at: Date.now(),
      oracle: buildOracle({ eibiOnAir, spots, flux, kp }),
      upstream: {
        eibi: out.eibi ? (out.eibi.ok ? 'ok' : out.eibi.error) : 'skipped',
        spots: out.spots ? (out.spots.ok ? 'ok' : out.spots.error) : 'skipped',
        flux: out.flux.ok ? 'ok' : out.flux.error,
        kp: out.kp.ok ? 'ok' : out.kp.error,
      },
    };
  }

  function refreshSingleFlight(origin) {
    if (!inflight) {
      inflight = refreshUpstream(origin).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  const installMiddleware = (server) => {
    server.middlewares.use(SHORTWAVE_ROUTE, async (req, res) => {
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
            mem = await refreshSingleFlight(originFromReq(req));
          } catch (err) {
            console.warn(
              '[shortwave-oracle] upstream failed:',
              err?.message || err,
            );
            if (!mem) {
              sendJson(503, { error: 'shortwave_oracle_unavailable' });
              return;
            }
          }
        }
        sendJson(200, {
          ...mem.oracle,
          cachedAt: new Date(mem.at).toISOString(),
          upstream: mem.upstream,
        });
      } catch (err) {
        console.error('[shortwave-oracle] request failed');
        sendJson(500, { error: 'shortwave oracle error' });
      }
    });
  };

  return {
    name: 'shortwave-oracle',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
