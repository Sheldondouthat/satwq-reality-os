#!/usr/bin/env node
/**
 * Build and publish the NDBC HF-radar surface-currents snapshot for the Pages deploy.
 *
 * NDBC serves hourly gridded HF-radar total-vector fields as NetCDF-4 via
 * THREDDS (https://dods.ndbc.noaa.gov/thredds/catalog/hfradar/catalog.html).
 * NetCDF-4 is HDF5-based — no pure-JS edge decode exists — and the full grids
 * are far too heavy for the edge, so the /api/currents provider
 * (server/providers/wave8/currents.js) serves a pre-subsetted snapshot
 * instead. THIS script is the only place the upstream is ever touched: it
 * runs in GitHub Actions, reads the machine-readable catalog.xml, picks the
 * newest file per configured region, pulls a STRIDED SUBSET through the
 * THREDDS OPeNDAP `.ascii` service (plain text — no NetCDF library needed),
 * scales Int16 → m/s, drops fill values, validates the result, and publishes
 * it to the `hfradar-latest` GitHub release on Sheldondouthat/satwq-reality-os:
 *
 *   hfradar-latest.json — {format, fetchedAt, regions:[{region, upstreamFile, upstreamUrl, time, pointCount, stats, lon, lat, u, v}]}
 *   hfradar-meta.json   — provenance for the snapshot pipeline itself
 *
 * ANY failure exits non-zero BEFORE the release is touched, so the last good
 * snapshot stays live. This script never writes synthetic current data: if
 * the NDBC upstream is unreachable it reports the exact error and exits 1.
 *
 * Usage:
 *   node scripts/hfradar-snapshot.mjs [--regions rtv-usegc-6km-uwls,rtv-gak-6km-uwls]
 *     [--stride 20] [--dry-run] [--out-dir /tmp/hfradar-snap]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildCurrentsSnapshot,
  MIN_REGION_POINTS,
  parseHfradarAscii,
  validateCurrentsSnapshot,
} from '../server/providers/wave8/currents.js';

const REPO = 'Sheldondouthat/satwq-reality-os';
const TAG = 'hfradar-latest';
const DODS_BASE = 'https://dods.ndbc.noaa.gov';
const CATALOG_URL = `${DODS_BASE}/thredds/catalog/hfradar/catalog.xml`;
const FETCH_TIMEOUT_MS = 180_000;
const CATALOG_CAP_BYTES = 16 * 1024 * 1024; // catalog.xml is ~9.4 MB
const DDS_CAP_BYTES = 256 * 1024;
const ASCII_CAP_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_CAP_BYTES = 512 * 1024;
const USER_AGENT = 'SATWQ-Reality-OS/1.0 (HF-radar snapshot pipeline)';
// Regions observed in the NDBC catalog (2026-09-27). usegc = US East/Gulf
// Coast, gak = Gulf of Alaska, ushi = Hawaii, prvi = Puerto Rico/VI,
// glna = Great Lakes. "<res>" is the grid resolution; "uwls" the product.
const ALLOWED_REGIONS = [
  'rtv-usegc-6km-uwls',
  'rtv-usegc-2km-uwls',
  'rtv-usegc-1km-uwls',
  'rtv-gak-6km-uwls',
  'rtv-gak-2km-uwls',
  'rtv-ushi-2km-uwls',
  'rtv-ushi-1km-uwls',
  'rtv-prvi-6km-uwls',
  'rtv-prvi-2km-uwls',
  'rtv-glna-6km-uwls',
  'rtv-glna-2km-uwls',
  'rtv-glna-1km-uwls',
];
const SCALE_FACTOR = 0.01; // .das: u/v Float32 scale_factor 0.01, units "m s-1"
const FILL_VALUE = -32767; // .das: u/v Int16 _FillValue -32767
// HF-radar coverage is sparse (observed 2026-09-27: usegc 6km ~1.7% valid,
// gak 6km ~0.14% valid), so a coarse stride can return zero valid cells even
// when the file has data. The script walks a stride ladder (fine → finer)
// per file until MIN_REGION_POINTS is met.
const MAX_REGION_POINTS = 4000; // deterministic thinning cap per region

const fail = (message) => {
  console.error(`[hfradar-snapshot] FATAL: ${message}`);
  process.exit(1);
};

const usage = () => `Usage: node scripts/hfradar-snapshot.mjs [options]
  --regions CSV  region ids, comma-separated (default: rtv-usegc-6km-uwls,rtv-gak-6km-uwls)
                 allowed: ${ALLOWED_REGIONS.join(', ')}
  --stride INT   starting OPeNDAP subset stride 1..100 (default: 2);
                 the script walks a halving stride ladder per file until
                 enough valid vectors are found
  --dry-run      run the full pipeline but do not touch the GitHub release
  --out-dir PATH snapshot output directory (default: /tmp/hfradar-snap)
  --retries INT   catalog fetch attempts, 1..10 (default: 5)
  --max-lookback INT recent catalog files to try per region, 1..24
                 (default: 6; the newest hourly file can be nearly empty)`;

/** Strict argv parsing: unknown flags and bad values exit 2 with usage. */
export function parseArgs(argv) {
  const opts = {
    regions: ['rtv-usegc-6km-uwls', 'rtv-gak-6km-uwls'],
    stride: 2,
    retries: 5,
    maxLookback: 6,
    dryRun: false,
    outDir: '/tmp/hfradar-snap',
  };
  const intOpt = (arg, raw, min, max) => {
    if (!/^\d+$/.test(raw))
      throw new Error(`${arg} must be an integer, got "${raw}"`);
    const v = Number(raw);
    if (v < min || v > max)
      throw new Error(`${arg} must be ${min}..${max}, got ${v}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`missing value for ${arg}`);
      }
      i++;
      return v;
    };
    if (arg === '--regions') {
      const parts = next()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!parts.length) throw new Error('--regions needs at least one region');
      for (const r of parts) {
        if (!ALLOWED_REGIONS.includes(r)) {
          throw new Error(
            `unknown region "${r}" (allowed: ${ALLOWED_REGIONS.join(', ')})`,
          );
        }
      }
      opts.regions = [...new Set(parts)];
    } else if (arg === '--stride') {
      const raw = next();
      if (!/^\d+$/.test(raw))
        throw new Error(`--stride must be an integer, got "${raw}"`);
      const s = Number(raw);
      if (s < 1 || s > 100)
        throw new Error(`--stride must be 1..100, got ${s}`);
      opts.stride = s;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--retries') {
      opts.retries = intOpt(arg, next(), 1, 10);
    } else if (arg === '--max-lookback') {
      opts.maxLookback = intOpt(arg, next(), 1, 24);
    } else if (arg === '--out-dir') {
      opts.outDir = next();
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return opts;
}

/** Run gh; throws with the command's stderr on failure. */
function gh(...args) {
  try {
    return execFileSync('gh', [...args, '--repo', REPO], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error.stderr?.toString().trim() || error.message;
    throw new Error(`gh ${args.join(' ')} failed: ${stderr}`);
  }
}

async function fetchWithTimeout(url, { accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('fetch timed out')),
    FETCH_TIMEOUT_MS,
  );
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: accept ?? '*/*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res, capBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > capBytes) {
    throw new Error(
      `declared content-length ${declared} exceeds cap ${capBytes}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > capBytes)
    throw new Error(`body exceeded cap ${capBytes} bytes`);
  return buf;
}

/**
 * Streaming capped body read: enforces capBytes incrementally as chunks
 * arrive instead of buffering the whole body first. A truncated transfer
 * (socket close mid-body, as observed through the proxy on the ~9.4 MB
 * catalog.xml) surfaces as a read error here rather than a silent short
 * buffer, so the caller can retry the whole fetch.
 */
async function readCappedStream(res, capBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > capBytes) {
    throw new Error(
      `declared content-length ${declared} exceeds cap ${capBytes}`,
    );
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > capBytes) {
        throw new Error(`body exceeded cap ${capBytes} bytes`);
      }
      chunks.push(
        Buffer.from(value.buffer, value.byteOffset, value.byteLength),
      );
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetch catalog.xml with bounded whole-fetch retry. The catalog is ~9.4 MB
 * and the transfer can die near the end (observed: 9,396,626 bytes then
 * UND_ERR_SOCKET through the proxy). Each attempt re-fetches from byte 0 —
 * there is no resume — with linear backoff between attempts.
 */
async function fetchCatalogXml({ retries }) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(
        `[hfradar-snapshot] fetching THREDDS catalog.xml (attempt ${attempt}/${retries})…`,
      );
      const res = await fetchWithTimeout(CATALOG_URL, {
        accept: 'application/xml',
      });
      return (await readCappedStream(res, CATALOG_CAP_BYTES)).toString('utf8');
    } catch (error) {
      lastError = error;
      console.log(
        `[hfradar-snapshot] catalog attempt ${attempt} failed: ${error.message}`,
      );
      if (attempt < retries)
        await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastError;
}

/**
 * Find the newest catalog urlPath for one region. File names carry the
 * validity start as `_sYYYYMMDDHHMMSS_`; the max timestamp wins rather than
 * assuming catalog order (the catalog is usually oldest-first, but order is
 * not contractual). Files without a parseable timestamp fall back to
 * last-match order. Returns the file name
 * (e.g. "rtv-usegc-6km-uwls_v1r0_hfr_s202609272000000_e…_c….nc") or null.
 */
export function parseCatalogForRegion(xml, region) {
  const files = listCatalogFilesForRegion(xml, region);
  return files.length ? files[0].file : null;
}

/**
 * List ALL catalog files for a region, newest first. File names carry the
 * validity start as `_sYYYYMMDDHHMMSS_`; sorting is by that timestamp, not
 * catalog order (the catalog is usually oldest-first, but order is not
 * contractual). Files without a parseable timestamp sort last, in catalog
 * order. Each entry is {file, ts} with ts the raw timestamp string or null.
 */
export function listCatalogFilesForRegion(xml, region) {
  const re = new RegExp(`urlPath="hfradar/((?:${region})[^"]+\\.nc)"`, 'g');
  const out = [];
  for (const m of xml.matchAll(re)) {
    const file = m[1];
    const ts = file.match(/_s(\d{12,17})_/)?.[1] ?? null;
    out.push({ file, ts });
  }
  out.sort((a, b) => {
    if (a.ts && b.ts) {
      if (a.ts.length !== b.ts.length) return b.ts.length - a.ts.length;
      if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
      return 0;
    }
    if (a.ts) return -1;
    if (b.ts) return 1;
    return 0; // stable sort: catalog order preserved for untimestamped files
  });
  return out;
}

/** Extract lat/lon axis lengths from a .dds response. */
export function parseDdsDims(dds) {
  const latM = dds.match(/Float32 lat\[lat = (\d+)\]/);
  const lonM = dds.match(/Float32 lon\[lon = (\d+)\]/);
  if (!latM || !lonM) throw new Error('dds missing lat/lon axis declarations');
  return { latN: Number(latM[1]), lonM: Number(lonM[1]) };
}

export function buildAsciiUrl(file, { latN, lonM }, stride) {
  const latSel = `0:${stride}:${latN - 1}`;
  const lonSel = `0:${stride}:${lonM - 1}`;
  const query =
    `u[0:1:0][${latSel}][${lonSel}]` +
    `,v[0:1:0][${latSel}][${lonSel}]` +
    `,lat[${latSel}],lon[${lonSel}],time[0:1:0]`;
  return `${DODS_BASE}/thredds/dodsC/hfradar/${file}.ascii?${query}`;
}

function roundTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Stride ladder for adaptive subsetting: start at the requested stride and
 * halve down to 1 (deduplicated, descending). Sparse HF-radar coverage means
 * a coarse stride can yield zero valid cells from a file that does hold
 * data (observed 2026-09-27: gak 6km gave 0/1/7/31 valid at strides
 * 20/8/4/2), so the caller tries finer strides before falling back to an
 * older file.
 */
export function strideLadder(start) {
  const ladder = [];
  let s = Math.max(1, Math.min(100, Math.floor(start)));
  while (s >= 1) {
    if (!ladder.includes(s)) ladder.push(s);
    if (s === 1) break;
    s = Math.max(1, Math.ceil(s / 2));
    if (ladder.length > 8) break; // safety; cannot happen for start <= 100
  }
  return ladder;
}

/**
 * Deterministically thin parallel arrays to at most max points by taking
 * every kth element. Keeps the snapshot bounded when coverage is dense.
 */
export function thinPoints(arrays, max) {
  const n = arrays[0].length;
  if (n <= max) return arrays;
  const k = Math.ceil(n / max);
  return arrays.map((a) => a.filter((_, i) => i % k === 0));
}

/**
 * Fetch one region file's strided subset (dds → dims → ascii → scaled valid
 * points). Throws on any fetch/parse failure; the caller decides whether to
 * try an older file. Returns {lon, lat, u, v, time}.
 */
async function fetchRegionSubset(file, stride) {
  const ddsUrl = `${DODS_BASE}/thredds/dodsC/hfradar/${file}.dds`;
  const dds = (
    await readCapped(
      await fetchWithTimeout(ddsUrl, { accept: 'text/plain' }),
      DDS_CAP_BYTES,
    )
  ).toString('utf8');
  let dims;
  try {
    dims = parseDdsDims(dds);
  } catch (error) {
    throw new Error(`dds parse failed for ${file}: ${error.message}`);
  }
  const asciiUrl = buildAsciiUrl(file, dims, stride);
  const ascii = (
    await readCapped(
      await fetchWithTimeout(asciiUrl, { accept: 'text/plain' }),
      ASCII_CAP_BYTES,
    )
  ).toString('utf8');
  let parsed;
  try {
    parsed = parseHfradarAscii(ascii);
  } catch (error) {
    throw new Error(`ascii parse failed for ${file}: ${error.message}`);
  }
  // Scale Int16 → m/s and drop fill values; keep flat valid-point arrays.
  const lon = [];
  const lat = [];
  const u = [];
  const v = [];
  for (let r = 0; r < parsed.lat.length; r++) {
    for (let c = 0; c < parsed.lon.length; c++) {
      const rawU = parsed.u[r][c];
      const rawV = parsed.v[r][c];
      if (rawU === FILL_VALUE || rawV === FILL_VALUE) continue;
      lon.push(roundTo(parsed.lon[c], 4));
      lat.push(roundTo(parsed.lat[r], 4));
      u.push(roundTo(rawU * SCALE_FACTOR, 3));
      v.push(roundTo(rawV * SCALE_FACTOR, 3));
    }
  }
  return { lon, lat, u, v, time: parsed.time };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[hfradar-snapshot] ${error.message}\n${usage()}`);
    process.exit(2);
  }
  console.log(
    `[hfradar-snapshot] regions=${opts.regions.join(',')} stride=${opts.stride}` +
      (opts.dryRun ? ' DRY-RUN (no release publish)' : ''),
  );

  const catalogXml = await fetchCatalogXml({ retries: opts.retries }).catch(
    (e) => fail(`catalog fetch failed after ${opts.retries} attempts: ${e.message}`),
  );

  const fetchedAt = new Date().toISOString();
  const regions = [];
  for (const region of opts.regions) {
    // Newest-first candidate files. The newest hourly file can be nearly
    // empty (observed 2026-09-27: 1 valid vector in the 20:00Z usegc file),
    // so walk back up to --max-lookback files and take the first with enough
    // valid points. A fetch/parse failure for one file is not fatal either —
    // the next older file is tried before giving up on the region.
    const candidates = listCatalogFilesForRegion(catalogXml, region).slice(
      0,
      opts.maxLookback,
    );
    if (!candidates.length) fail(`no catalog entries for region ${region}`);
    let chosen = null;
    const attempts = [];
    const ladder = strideLadder(opts.stride);
    for (const { file } of candidates) {
      let fileDone = false;
      for (const stride of ladder) {
        let data;
        try {
          data = await fetchRegionSubset(file, stride);
        } catch (error) {
          attempts.push(`${file}@s${stride}: error ${error.message}`);
          console.log(
            `[hfradar-snapshot] ${region}: ${file}@stride${stride} failed ` +
              `(${error.message}) — trying previous file…`,
          );
          break; // fetch error: a finer stride won't fix the transport
        }
        attempts.push(`${file}@s${stride}: ${data.lon.length} valid`);
        if (data.lon.length >= MIN_REGION_POINTS) {
          // Deterministic thinning cap keeps the edge snapshot bounded.
          const [lon, lat, u, v] = thinPoints(
            [data.lon, data.lat, data.u, data.v],
            MAX_REGION_POINTS,
          );
          chosen = { file, stride, time: data.time, lon, lat, u, v };
          if (file !== candidates[0].file || stride !== ladder[0]) {
            console.log(
              `[hfradar-snapshot] ${region}: using ${file} at stride ` +
                `${stride} (${lon.length} valid vectors)`,
            );
          }
          fileDone = true;
          break;
        }
        console.log(
          `[hfradar-snapshot] ${region}: ${file}@stride${stride} only ` +
            `${data.lon.length} valid vectors (min ${MIN_REGION_POINTS}) — ` +
            `trying finer stride…`,
        );
      }
      if (fileDone) break;
      if (
        attempts.length &&
        attempts[attempts.length - 1].startsWith(`${file}@s1:`)
      ) {
        console.log(
          `[hfradar-snapshot] ${region}: ${file} unusable even at stride 1 — ` +
            `trying previous file…`,
        );
      }
    }
    if (!chosen) {
      fail(
        `no usable file for region ${region} in last ${candidates.length} ` +
          `catalog entries: ${attempts.join('; ')}`,
      );
    }
    console.log(
      `[hfradar-snapshot] ${region}: ${chosen.lon.length} valid vectors ` +
        `at ${chosen.time} (${chosen.file}@stride${chosen.stride})`,
    );
    regions.push({
      region,
      upstreamFile: chosen.file,
      upstreamUrl: `${DODS_BASE}/thredds/dodsC/hfradar/${chosen.file}`,
      time: chosen.time,
      stride: chosen.stride,
      lon: chosen.lon,
      lat: chosen.lat,
      u: chosen.u,
      v: chosen.v,
    });
  }

  let snapshot;
  try {
    snapshot = buildCurrentsSnapshot({ fetchedAt, regions });
    validateCurrentsSnapshot(snapshot);
  } catch (error) {
    fail(`snapshot build/validate failed: ${error.message}`);
  }

  mkdirSync(opts.outDir, { recursive: true });
  const snapPath = path.join(opts.outDir, 'hfradar-latest.json');
  const metaPath = path.join(opts.outDir, 'hfradar-meta.json');
  const snapBytes = new TextEncoder().encode(JSON.stringify(snapshot));
  if (snapBytes.length > SNAPSHOT_CAP_BYTES) {
    fail(`snapshot too large for edge: ${snapBytes.length} bytes`);
  }
  writeFileSync(snapPath, snapBytes);
  const meta = {
    pipeline: 'scripts/hfradar-snapshot.mjs',
    regions: regions.map((r) => ({
      region: r.region,
      upstreamFile: r.upstreamFile,
      time: r.time,
      stride: r.stride,
      pointCount: r.lon.length,
    })),
    stride: opts.stride,
    fetchedAt,
    snapshotBytes: snapBytes.length,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // Read-back verification: the bytes we are about to publish must be exactly
  // what the edge provider validates.
  try {
    if (statSync(snapPath).size !== snapBytes.length) {
      throw new Error('hfradar-latest.json size mismatch on read-back');
    }
    const back = JSON.parse(readFileSync(snapPath, 'utf8'));
    validateCurrentsSnapshot(back);
  } catch (error) {
    fail(`snapshot verification failed: ${error.message}`);
  }
  console.log(
    `[hfradar-snapshot] snapshot verified locally (${snapBytes.length} bytes).`,
  );

  publishRelease({ snapPath, metaPath, dryRun: opts.dryRun });
}

/**
 * Publish the snapshot assets to the GitHub release. Exported for tests:
 * pass dryRun:true and a recording runGh to prove a dry run can never
 * invoke gh. Production main() passes no runGh, so the real gh runs.
 */
export function publishRelease({ snapPath, metaPath, dryRun, runGh = gh }) {
  if (dryRun) {
    console.log('[hfradar-snapshot] dry-run: skipping release publish.');
    console.log(`[hfradar-snapshot] files: ${snapPath}, ${metaPath}`);
    return { published: false };
  }

  // ---- From here on every step mutates the release; all prior steps passed.
  let releaseExists = true;
  try {
    runGh('release', 'view', TAG);
  } catch {
    releaseExists = false;
  }
  if (!releaseExists) {
    console.log(`[hfradar-snapshot] creating release ${TAG}…`);
    try {
      runGh(
        'release',
        'create',
        TAG,
        '--title',
        'NDBC HF-radar surface currents snapshot (latest)',
        '--notes',
        'Latest pre-subsetted NDBC/IOOS HF-radar surface-current snapshot for the Cloudflare Pages deploy. ' +
          'Refreshed by scripts/hfradar-snapshot.mjs; hfradar-latest.json holds strided u/v vectors ' +
          'per region. Source data: NOAA NDBC HF-radar (public domain).',
      );
    } catch (error) {
      fail(error.message);
    }
  }
  console.log('[hfradar-snapshot] uploading assets (--clobber)…');
  try {
    runGh('release', 'upload', TAG, snapPath, metaPath, '--clobber');
  } catch (error) {
    fail(error.message);
  }
  const base = `https://github.com/${REPO}/releases/download/${TAG}`;
  console.log('[hfradar-snapshot] published:');
  console.log(`  ${base}/hfradar-latest.json`);
  console.log(`  ${base}/hfradar-meta.json`);
  return { published: true };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  await main();
}
