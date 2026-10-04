/**
 * Wave 6 — NOAA Coral Reef Watch SST animation manifest (keyless, no bytes proxied).
 *
 * Returns a manifest of CRW 5km 30-day sea-surface-temperature animation
 * GIFs — one per region — that the UI can load directly as image layers.
 * The edge never proxies image bytes:
 *
 *   #144 https://coralreefwatch.noaa.gov/data_current/5km/v3.1_op/animation/gif/
 *        sst_animation_30day_{region}_930x580.gif   (animated GIF, daily)
 *
 * Regions: crb, 45ns, coraltriangle, east, fl, gbr, hi, indian.
 *
 * Routes:
 *   GET /api/coral → {generatedAt, count, attribution, animations:[…]}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only,
 * redirect:'follow' — workerd supports only 'follow'/'manual'; 'error'
 * throws at the edge (main 2ec4053), no node: imports, no WASM).
 *
 * Probe notes (2026-09-27, build VM): the crb GIF returned HTTP 206 with
 * content-type image/gif (range probe); the URL pattern is the one the
 * feed-catalog survey verified 200 earlier on 2026-09-27. Region codes are
 * the CRW directory names; display names are given only where the code is
 * unambiguous.
 */

const CRW_BASE =
  'https://coralreefwatch.noaa.gov/data_current/5km/v3.1_op/animation/gif';
const CACHE_TTL_MS = 6 * 60 * 60_000; // GIFs regenerate daily; the manifest is stable

const ANIMATIONS = [
  {
    id: 'crw-sst-crb',
    region: 'crb',
    name: 'Caribbean',
    url: `${CRW_BASE}/sst_animation_30day_crb_930x580.gif`,
  },
  {
    id: 'crw-sst-45ns',
    region: '45ns',
    name: '45°N/S region',
    url: `${CRW_BASE}/sst_animation_30day_45ns_930x580.gif`,
  },
  {
    id: 'crw-sst-coraltriangle',
    region: 'coraltriangle',
    name: 'Coral Triangle',
    url: `${CRW_BASE}/sst_animation_30day_coraltriangle_930x580.gif`,
  },
  {
    id: 'crw-sst-east',
    region: 'east',
    name: 'Eastern Pacific',
    url: `${CRW_BASE}/sst_animation_30day_east_930x580.gif`,
  },
  {
    id: 'crw-sst-fl',
    region: 'fl',
    name: 'Florida',
    url: `${CRW_BASE}/sst_animation_30day_fl_930x580.gif`,
  },
  {
    id: 'crw-sst-gbr',
    region: 'gbr',
    name: 'Great Barrier Reef',
    url: `${CRW_BASE}/sst_animation_30day_gbr_930x580.gif`,
  },
  {
    id: 'crw-sst-hi',
    region: 'hi',
    name: "Hawai'i",
    url: `${CRW_BASE}/sst_animation_30day_hi_930x580.gif`,
  },
  {
    id: 'crw-sst-indian',
    region: 'indian',
    name: 'Indian Ocean',
    url: `${CRW_BASE}/sst_animation_30day_indian_930x580.gif`,
  },
].map((a) => ({
  ...a,
  format: 'animated GIF 930×580',
  cadence: 'daily, 30-day window',
  attribution: 'NOAA Coral Reef Watch',
  license: 'NOAA public domain',
  probe: 'vm-206',
}));

const PROBE_NOTE =
  'probe legend — vm-206: range probe returned HTTP 206 image/gif from the build VM on 2026-09-27; ' +
  'the GIF URL pattern was verified 200 by the feed-catalog survey earlier on 2026-09-27.';

let cache = null; // {at, payload}
let inflight = null;

function buildManifest() {
  return {
    generatedAt: new Date().toISOString(),
    count: ANIMATIONS.length,
    attribution:
      'Sea-surface-temperature animations: NOAA Coral Reef Watch 5km v3.1 (public domain). ' +
      'Satellite/model imagery — label honestly as model-blended SST. ' +
      'Manifest only — GIF bytes are loaded client-side from the origin host.',
    probeNote: PROBE_NOTE,
    animations: ANIMATIONS.map((a) => ({ ...a })),
  };
}

async function getManifest() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.resolve(buildManifest())
      .then((payload) => {
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=21600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

export function coralProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getManifest());
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'coral_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'coral',
    configureServer({ middlewares }) {
      middlewares.use('/api/coral', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/coral', handler);
    },
  };
}

export const _coralInternals = {
  ANIMATIONS,
  buildManifest,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
