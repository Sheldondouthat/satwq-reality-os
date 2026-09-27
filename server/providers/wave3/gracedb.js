/**
 * Spacetime ripples proxy (keyless) — /api/gravwaves.
 *
 * LIGO/Virgo/KAGRA public gravitational-wave alerts via the public,
 * keyless GraceDB REST API:
 *   https://gracedb.ligo.org/api/superevents/
 *
 * Verified live 2026-09-27 (findings, not bugs):
 *  - HTTP 200, {"numRows": N, "superevents": [...]} — the 100 most recent
 *    superevents; the anonymous endpoint IGNORES filter/pagination params
 *    (?q=, ?category=, ?offset=, ?page=, ?N= all had no effect).
 *  - As of 2026-09-27 the recent window is dominated by MDC (Mock Data
 *    Challenge) pipeline test injections — zero Production events in the
 *    visible 100. These are labeled honestly as MOCK, never as detections.
 *  - /api/v2/superevents/<id>/ exposes category, far, labels,
 *    preferred_event_data (group/pipeline/instruments).
 *  - Source classification (BNS/NSBH/BBH/Terrestrial probabilities) ships
 *    inside the GCN-notice JSON at files/<id>-initial.json,0 as
 *    /event/classification (verified live: {"BNS": 0.99999...}).
 *
 * Honesty model: each event carries its true category. MDC = injected test
 * signal for pipeline validation — cosmically real as a waveform template,
 * NOT a real detection. Production events are real public alerts.
 * Displayed on a SKY overlay in the frontend — these are distant cosmic
 * events, never plotted on the Earth globe.
 *
 * Pages-safe: this module imports NOTHING (plain global fetch + JSON only),
 * no node: imports, no WASM, no fs.
 */

const SUPER_URL = 'https://gracedb.ligo.org/api/superevents/';
const DETAIL_URL = (id) => `https://gracedb.ligo.org/api/v2/superevents/${encodeURIComponent(id)}/`;
const USER_AGENT = 'satwq-reality-os (public GraceDB context)';
const UPSTREAM_TIMEOUT_MS = 20_000;
const LIST_CAP_BYTES = 1024 * 1024;
const FILE_CAP_BYTES = 512 * 1024;
const CACHE_TTL_MS = 30 * 60 * 1000;
const EVENT_CAP = 12;
const CONCURRENCY = 4;
const GRACEDB_PAGE = (id) => `https://gracedb.ligo.org/superevents/${encodeURIComponent(id)}/view/`;

const CATEGORY_NOTES = {
  Production: 'real public alert from the LVK search pipelines',
  MDC: 'MOCK DATA CHALLENGE — injected test signal for pipeline validation, not a real detection',
  Test: 'engineering test event — not a real detection',
};

const CLASS_RE = /"classification"\s*:\s*\{([^}]*)\}/;
const CLASS_ENTRY_RE = /"(BNS|NSBH|BBH|Terrestrial)"\s*:\s*([0-9.eE+-]+)/g;

/**
 * Extract {BNS, NSBH, BBH, Terrestrial} probabilities from a GCN-notice
 * JSON string via regex (avoids parsing ~1 MB files in full). Returns the
 * object or null when absent. Exported for unit tests.
 */
export function extractClassification(noticeText) {
  if (typeof noticeText !== 'string') return null;
  const m = noticeText.match(CLASS_RE);
  if (!m) return null;
  const out = {};
  let e;
  CLASS_ENTRY_RE.lastIndex = 0;
  while ((e = CLASS_ENTRY_RE.exec(m[1])) !== null) {
    const v = Number(e[2]);
    if (Number.isFinite(v)) out[e[1]] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Human-readable false-alarm-rate: "1 per ~N years". Exported for tests. */
export function farDescription(farHz) {
  if (!Number.isFinite(farHz) || farHz <= 0) return null;
  const perYear = farHz * 31557600;
  if (perYear <= 0) return null;
  const years = 1 / perYear;
  if (years >= 1000) return `1 per ~${Math.round(years / 100) * 100} years`;
  if (years >= 100) return `1 per ~${Math.round(years)} years`;
  if (years >= 2) return `1 per ~${years.toFixed(1)} years`;
  if (years >= 1) return 'about 1 per year';
  const perMonth = perYear / 12;
  if (perMonth >= 1) return `~${perMonth.toFixed(1)} per month`;
  return `~${perYear.toFixed(1)} per year`;
}

async function fetchTextCapped(url, capBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok)
      throw Object.assign(new Error(`gravwaves_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error('gravwaves_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (error) {
        out[i] = { __error: String(error?.message ?? error) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function pickInitialNotice(filesObj) {
  if (!filesObj || typeof filesObj !== 'object') return null;
  const names = Object.keys(filesObj);
  const candidates = names
    .filter((n) => /-initial\.json,\d+$/.test(n))
    .sort((a, b) => Number(a.split(',').pop()) - Number(b.split(',').pop()));
  return candidates[0] ?? null;
}

async function enrichEvent(summary) {
  const id = summary?.superevent_id;
  if (!id) return null;
  let classification = null;
  try {
    const detailText = await fetchTextCapped(DETAIL_URL(id), LIST_CAP_BYTES);
    const detail = JSON.parse(detailText);
    const pe = detail?.preferred_event_data ?? {};
    const filesText = await fetchTextCapped(detail?.links?.files ?? '', LIST_CAP_BYTES);
    const noticeName = pickInitialNotice(JSON.parse(filesText));
    if (noticeName) {
      const noticeText = await fetchTextCapped(
        `${detail.links.files}${encodeURIComponent(noticeName)}`,
        FILE_CAP_BYTES,
      );
      classification = extractClassification(noticeText);
    }
    return {
      id,
      category: summary.category ?? null,
      categoryNote:
        CATEGORY_NOTES[summary.category] ?? 'unclassified GraceDB category',
      createdUtc: summary.created ?? null,
      t0Gps: Number.isFinite(summary.t_0) ? summary.t_0 : null,
      farHz: Number.isFinite(summary.far) ? summary.far : null,
      farDescription: farDescription(summary.far),
      searchGroup: pe.group ?? null,
      pipeline: pe.pipeline ?? null,
      instruments: pe.instruments ?? null,
      labels: Array.isArray(summary.labels) ? summary.labels : [],
      classification,
      classificationNote: classification
        ? 'source-class probabilities from the public GCN notice (model output, not a confirmed source type)'
        : 'no published source classification for this event',
      gracedbUrl: GRACEDB_PAGE(id),
    };
  } catch {
    return {
      id,
      category: summary.category ?? null,
      categoryNote: CATEGORY_NOTES[summary.category] ?? 'unclassified GraceDB category',
      createdUtc: summary.created ?? null,
      t0Gps: Number.isFinite(summary.t_0) ? summary.t_0 : null,
      farHz: Number.isFinite(summary.far) ? summary.far : null,
      farDescription: farDescription(summary.far),
      searchGroup: null,
      pipeline: null,
      instruments: null,
      labels: Array.isArray(summary.labels) ? summary.labels : [],
      classification: null,
      classificationNote: 'enrichment unavailable — showing alert metadata only',
      gracedbUrl: GRACEDB_PAGE(id),
    };
  }
}

let cache = null; // { at, payload }

async function buildSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  const listText = await fetchTextCapped(SUPER_URL, LIST_CAP_BYTES);
  const list = JSON.parse(listText);
  const superevents = Array.isArray(list?.superevents) ? list.superevents : [];
  const ranked = [...superevents].sort((a, b) => {
    const ac = a.category === 'Production' ? 0 : 1;
    const bc = b.category === 'Production' ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return String(b.created ?? '').localeCompare(String(a.created ?? ''));
  });
  const chosen = ranked.slice(0, EVENT_CAP);
  const enriched = (await mapLimit(chosen, CONCURRENCY, enrichEvent)).filter(Boolean);
  const production = enriched.filter((e) => e.category === 'Production').length;
  const payload = {
    schemaVersion: 1,
    fetchedAt: new Date(now).toISOString(),
    source: 'GraceDB public superevent API (keyless)',
    displayNote:
      'Gravitational-wave events are distant cosmic events — shown on a SKY ' +
      'overlay, never on the Earth globe. Mock (MDC/Test) injections are ' +
      'pipeline test signals, not real detections.',
    totalListed: superevents.length,
    productionInView: production,
    events: enriched,
  };
  cache = { at: now, payload };
  return payload;
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': status === 200 ? 'public, max-age=600' : 'no-store',
  });
  res.end(JSON.stringify(value));
}

/** Mount the gravitational-wave proxy. Mirrors the vaac/hmsSmoke provider shape. */
export function gracedbProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
    try {
      sendJson(res, 200, await buildSnapshot());
    } catch (error) {
      sendJson(res, error?.status === 502 ? 502 : 500, {
        error: 'gravwaves_upstream_unavailable',
      });
    }
  }

  return {
    name: 'gravwaves',
    configureServer({ middlewares }) {
      middlewares.use('/api/gravwaves', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/gravwaves', handler);
    },
  };
}
