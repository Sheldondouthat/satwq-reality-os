/**
 * Wave 6 — volcano webcam manifest (keyless, no bytes proxied).
 *
 * AVO ASHCAM webcams are queried live through the ashcam image API; HVO's
 * Kīlauea K2cam is a pinned "latest" image URL loaded client-side:
 *
 *   #106 AVO  https://avo.alaska.edu/ashcam-api/imageApi/webcam/{code}/0/0/1
 *             → JSON rows (imageId/md5/timestamp/imageUrl/suninfo); the
 *             returned imageUrl is handed to the client, never proxied.
 *   #107 AVO  direct-image URL pattern (documented, served from imageUrl).
 *   #108 HVO  https://volcanoes.usgs.gov/observatories/hvo/cams/K2cam/images/M.jpg
 *
 * ASHCAM webcam codes (verified 2026-09-27 against the AVO webcam index
 * page https://avo.alaska.edu/webcam/ and the /webcam/view/1401 detail
 * page, which shows the code format {volcano}_{site} lowercase, e.g.
 * "shishaldin_brpk"):
 *   shishaldin_brpk, shishaldin_islz, cleveland_clcl, cleveland_clco,
 *   pavlof_blha, great_sitkin_gsck, veniaminof_vnsg
 *
 * Routes:
 *   GET /api/volcano-cams → {generatedAt, sources:{…}, cams:[…]}
 *
 * A 502 is returned only when EVERY source fails; per-source failures are
 * recorded honestly in `sources.<key>.error`.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 512 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const USER_AGENT = 'Gods Eye View (volcano cam manifest)';
const ASHCAM_API = 'https://avo.alaska.edu/ashcam-api/imageApi/webcam';

const ASHCAM_CAMS = [
  { code: 'shishaldin_brpk', volcano: 'Shishaldin', site: 'BRPK' },
  { code: 'shishaldin_islz', volcano: 'Shishaldin', site: 'ISLZ' },
  { code: 'cleveland_clcl', volcano: 'Cleveland', site: 'CLCL' },
  { code: 'cleveland_clco', volcano: 'Cleveland', site: 'CLCO' },
  { code: 'pavlof_blha', volcano: 'Pavlof', site: 'BLHA' },
  { code: 'great_sitkin_gsck', volcano: 'Great Sitkin', site: 'GSCK' },
  { code: 'veniaminof_vnsg', volcano: 'Veniaminof', site: 'VNSG' },
];

const HVO_CAMS = [
  {
    id: 'hvo-k2cam',
    volcano: 'Kīlauea',
    site: 'K2cam',
    url: 'https://volcanoes.usgs.gov/observatories/hvo/cams/K2cam/images/M.jpg',
    format: 'JPEG',
    cadence: 'minutes',
    attribution: 'USGS Hawaiian Volcano Observatory',
    license: 'US public domain',
    probe: 'vm-200',
  },
];

let cache = null; // {at, payload}
let inflight = null;

function fetchImplDefault(input, init) {
  return fetch(input, init);
}

/** AVO imageApi listing → {imageUrl, timestamp, imageId} of the newest frame, or null. */
export function parseAshcamListing(doc) {
  const rows = Array.isArray(doc)
    ? doc
    : Array.isArray(doc?.images)
      ? doc.images
      : null;
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  const imageUrl = String(row?.imageUrl ?? '').trim();
  if (!imageUrl) return null;
  return {
    imageUrl,
    timestamp: row?.timestamp ?? row?.time ?? null,
    imageId: row?.imageId ?? null,
  };
}

async function fetchJsonCapped(fetchImpl, url, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(
        new Error(`volcano_cams_upstream_${response.status}`),
        { status: 502 },
      );
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('volcano_cams_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAshcamCam(fetchImpl, cam) {
  const started = Date.now();
  const url = `${ASHCAM_API}/${cam.code}/0/0/1`;
  try {
    const doc = await fetchJsonCapped(fetchImpl, url, undefined);
    const frame = parseAshcamListing(doc);
    if (!frame) throw new Error(`volcano_cams_ashcam_empty_${cam.code}`);
    return {
      id: `avo-${cam.code}`,
      volcano: cam.volcano,
      site: cam.site,
      url: frame.imageUrl,
      imageId: frame.imageId,
      timestamp: frame.timestamp,
      format: 'JPEG',
      cadence: 'minutes',
      attribution: 'Alaska Volcano Observatory',
      license: 'AVO, cite as source',
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      id: `avo-${cam.code}`,
      volcano: cam.volcano,
      site: cam.site,
      error: error?.message ?? 'unknown',
      latencyMs: Date.now() - started,
    };
  }
}

function buildSnapshot(ashcamResults) {
  const cams = [];
  const errors = [];
  for (const r of ashcamResults) {
    if (r.url) {
      const { latencyMs, ...rest } = r;
      cams.push({ ...rest, ok: true });
    } else {
      errors.push(`${r.id}:${r.error}`);
    }
  }
  for (const h of HVO_CAMS) cams.push({ ...h, ok: true });
  const sources = {
    avo: {
      ok: cams.some((c) => c.id.startsWith('avo-')),
      liveCount: cams.filter((c) => c.id.startsWith('avo-')).length,
      requested: ASHCAM_CAMS.length,
      ...(errors.length ? { errors } : {}),
    },
    hvo: {
      ok: true,
      liveCount: HVO_CAMS.length,
      note: 'pinned latest-image URLs, verified 200 from build VM 2026-09-27',
    },
  };
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: cams.length,
    attribution:
      'Volcano cams: Alaska Volcano Observatory (cite AVO); USGS Hawaiian Volcano Observatory (public domain). ' +
      'Manifest only — image bytes are loaded client-side from the origin hosts.',
    cams,
  };
}

async function getSnapshot(fetchImpl) {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.all(
      ASHCAM_CAMS.map((cam) => fetchAshcamCam(fetchImpl, cam)),
    )
      .then((results) => {
        const payload = buildSnapshot(results);
        if (payload.count === 0) {
          throw Object.assign(new Error('volcano_cams_all_upstream_down'), {
            status: 502,
          });
        }
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=300') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

export function volcanoCamsProxy({ fetchImpl = fetchImplDefault } = {}) {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot(fetchImpl));
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'volcano_cams_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'volcanoCams',
    configureServer({ middlewares }) {
      middlewares.use('/api/volcano-cams', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/volcano-cams', handler);
    },
  };
}

export const _volcanoCamsInternals = {
  ASHCAM_CAMS,
  HVO_CAMS,
  parseAshcamListing,
  buildSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
