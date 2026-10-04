/**
 * Cloudflare Pages wind provider — WASM-free GFS snapshot proxy.
 *
 * server/providers/wind.js is excluded from the Pages Functions bundle: its
 * GRIB decoder pulls @meri-imperiumi/eccodes-wasm, whose wasm/eccodes.js does
 * require('path')/require('fs') and breaks the esbuild bundle step. This
 * provider serves the SAME frontend contract (/api/wind manifest + grid
 * binary) from a pre-decoded snapshot published to the `wind-latest` GitHub
 * release by scripts/wind-snapshot.mjs — no GRIB, no WASM, no node: imports
 * anywhere in this module's graph (this file imports nothing at all).
 *
 * Release assets (public repo, no auth needed):
 *   gfs.bin       — nx*ny*8 bytes, Float32 LE [u..., v...]
 *   gfs-meta.json — {cycle:{date,hour,forecastHour,runIso,validIso}, level,
 *                    units, grid:{nx,ny,lo1,la1,dx,dy}, generatedAt}
 *
 * Behavior:
 *  - model=gfs&overlay=none → live manifest built from the release assets,
 *    cached in-isolate for 30 minutes; `stale` is true when the snapshot's
 *    generatedAt is more than 12 h old.
 *  - model=ifs or any overlay other than none → the exact unavailable shape
 *    from server/providers/wind.js's unavailable(model, overlay) (there is no
 *    snapshot for those; the frontend degrades gracefully).
 *  - snapshot fetch/validation failure → the unavailable shape.
 */

const DEFAULT_RELEASE_BASE =
  'https://github.com/Sheldondouthat/satwq-reality-os/releases/download/wind-latest';
const CACHE_TTL_MS = 30 * 60 * 1000;
const STALE_AFTER_MS = 12 * 3600 * 1000;
const META_BUDGET_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Exact unavailable manifest shape from server/providers/wind.js's
 * unavailable(model, overlay). Duplicated (not imported) so this module's
 * graph never touches the WASM decoder.
 */
function unavailableManifest(model, overlay) {
  return {
    model,
    schemaVersion: 1,
    ...(overlay === 'none' ? {} : { overlay }),
    unavailable: true,
    stale: true,
    reason: 'Wind upstream unavailable',
  };
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

async function boundedRead(response, maxBytes) {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes)
    throw new Error('snapshot response exceeds byte budget');
  return new Uint8Array(buffer);
}

function validateMeta(meta) {
  const problems = [];
  if (!meta || typeof meta !== 'object') problems.push('meta is not an object');
  const cycle = meta?.cycle;
  if (
    !cycle ||
    typeof cycle !== 'object' ||
    !/^\d{8}$/.test(String(cycle.date)) ||
    ![0, 6, 12, 18].includes(cycle.hour) ||
    !Number.isInteger(cycle.forecastHour) ||
    cycle.forecastHour < 0
  )
    problems.push('bad cycle');
  const grid = meta?.grid;
  if (
    !grid ||
    !Number.isInteger(grid.nx) ||
    !Number.isInteger(grid.ny) ||
    grid.nx < 1 ||
    grid.ny < 1 ||
    grid.nx * grid.ny > 1_000_000 ||
    ![grid.lo1, grid.la1, grid.dx, grid.dy].every(Number.isFinite) ||
    grid.dx <= 0 ||
    grid.dy <= 0 ||
    Math.abs(grid.nx * grid.dx - 360) > 0.01
  )
    problems.push('bad grid');
  if (typeof meta?.level !== 'string' || typeof meta?.units !== 'string')
    problems.push('bad level/units');
  if (!Number.isFinite(Date.parse(meta?.generatedAt)))
    problems.push('bad generatedAt');
  if (problems.length)
    throw new Error(`invalid wind snapshot meta: ${problems.join('; ')}`);
  return meta;
}

function manifestIdFor(cycle) {
  return `gfs-${cycle.date}-${cycle.hour}-f${cycle.forecastHour}-1`;
}

export function windSnapshotProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  releaseBase = DEFAULT_RELEASE_BASE,
} = {}) {
  // In-isolate cache: { meta, manifest, manifestId, gridBytes, refreshedAt }.
  let cache = null;

  async function fetchRelease(asset, maxBytes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${releaseBase}/${asset}`, {
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`snapshot ${asset} HTTP ${response.status}`);
      return await boundedRead(response, maxBytes);
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadSnapshot() {
    const metaBytes = await fetchRelease('gfs-meta.json', META_BUDGET_BYTES);
    const meta = validateMeta(JSON.parse(new TextDecoder().decode(metaBytes)));
    const { nx, ny } = meta.grid;
    const expectedBytes = nx * ny * 8;
    const gridBytes = await fetchRelease('gfs.bin', expectedBytes + 1);
    if (gridBytes.byteLength !== expectedBytes)
      throw new Error(
        `snapshot grid size mismatch: ${gridBytes.byteLength} !== ${expectedBytes}`,
      );
    const generatedAtMs = Date.parse(meta.generatedAt);
    const manifestId = manifestIdFor(meta.cycle);
    const manifest = {
      schemaVersion: 1,
      model: 'gfs',
      cycle: meta.cycle,
      fetchedAt: generatedAtMs,
      level: meta.level,
      units: meta.units,
      grid: {
        nx,
        ny,
        lo1: meta.grid.lo1,
        la1: meta.grid.la1,
        dx: meta.grid.dx,
        dy: meta.grid.dy,
      },
      stale: now() - generatedAtMs > STALE_AFTER_MS,
      unavailable: false,
      reason: null,
      gridUrl: `/api/wind/grid/${manifestId}.bin?model=gfs`,
    };
    return { meta, manifest, manifestId, gridBytes };
  }

  async function ensureFresh() {
    if (cache && now() - cache.refreshedAt < CACHE_TTL_MS) return cache;
    const fresh = await loadSnapshot();
    cache = { ...fresh, refreshedAt: now() };
    return cache;
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const model = url.searchParams.get('model') || 'gfs';
    const overlay = url.searchParams.get('overlay') || 'none';
    if (req.method !== 'GET')
      return sendJson(res, { error: 'method_not_allowed' }, 405);
    if (model !== 'gfs' && model !== 'ifs')
      return sendJson(res, { error: 'unknown_model' }, 400);
    if (!['none', 'temperature', 'pressure'].includes(overlay))
      return sendJson(res, { error: 'unknown_overlay' }, 400);

    if (url.pathname.startsWith('/grid/')) {
      const id = url.pathname.slice(6).replace(/\.bin$/, '');
      let snapshot = null;
      try {
        snapshot = await ensureFresh();
      } catch {
        // Fall through to any retained cache below.
      }
      snapshot ??= cache;
      if (
        !snapshot ||
        url.pathname !== `/grid/${id}.bin` ||
        id !== snapshot.manifestId
      )
        return sendJson(res, { error: 'unknown_grid' }, 404);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600, immutable',
      });
      return res.end(snapshot.gridBytes);
    }

    if (!['/', '/manifest', '/status'].includes(url.pathname))
      return sendJson(res, { error: 'not_found' }, 404);

    // Only the gfs/none snapshot exists; everything else degrades exactly
    // like server/providers/wind.js's unavailable(model, overlay).
    let manifest;
    if (model === 'gfs' && overlay === 'none') {
      try {
        manifest = (await ensureFresh()).manifest;
      } catch {
        manifest = unavailableManifest(model, overlay);
      }
    } else {
      manifest = unavailableManifest(model, overlay);
    }
    if (url.pathname === '/status') {
      const { gridUrl, ...status } = manifest;
      return sendJson(res, status);
    }
    return sendJson(res, manifest);
  };

  return {
    name: 'wind-snapshot',
    configureServer({ middlewares }) {
      middlewares.use('/api/wind', handler);
    },
  };
}
