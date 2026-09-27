#!/usr/bin/env node
/**
 * Build and publish the DWD ICON-D2 2 m temperature snapshot for the Pages deploy.
 *
 * ICON-D2 NWP output is GRIB2 binary (https://opendata.dwd.de/weather/nwp/icon-d2/grib/,
 * 3-hourly runs) — the edge cannot parse GRIB, so the /api/icon-d2 provider
 * (server/providers/wave8/iconD2.js) serves a pre-binned snapshot instead.
 * THIS script is the only place a GRIB file is ever downloaded: it runs in
 * GitHub Actions (node:, bzip2, eccodes-wasm all available), picks the newest
 * model run that actually contains every requested forecast horizon, decodes
 * the regular-lat-lon t_2m GRIB2 for each horizon, bins it to a coarse grid
 * via binTemperatureGrid(), validates the result, and publishes it to the
 * `icon-d2-latest` GitHub release on Sheldondouthat/satwq-reality-os:
 *
 *   icon-d2-latest.json — {format, run, fetchedAt, param, units, grid, horizons:[{forecastHour, validTime, pointCount, missingCount, stats, values}]}
 *   icon-d2-meta.json   — provenance for the snapshot pipeline itself
 *
 * ANY failure exits non-zero BEFORE the release is touched, so the last good
 * snapshot stays live. This script never writes synthetic temperature data:
 * if the DWD upstream is unreachable it reports the exact error and exits 1.
 *
 * The icosahedral variant is deliberately NOT used: the eccodes-wasm build
 * cannot expose lat/lon for unstructured grids ("Failed to get size for key
 * 'latitudes'"), while regular-lat-lon decodes cleanly through the existing
 * decodeWindGribMessage() helper.
 *
 * Usage:
 *   node scripts/icon-d2-snapshot.mjs [--run HH] [--horizons 0,6,12,24]
 *     [--bin-deg 0.25] [--param t_2m] [--dry-run] [--out-dir /tmp/icon-d2-snap]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeWindGribMessage } from '../server/providers/wind/decode.js';
import {
  binTemperatureGrid,
  buildIconD2Snapshot,
  validateIconD2Snapshot,
} from '../server/providers/wave8/iconD2.js';

const REPO = 'Sheldondouthat/satwq-reality-os';
const TAG = 'icon-d2-latest';
const BASE_URL = 'https://opendata.dwd.de/weather/nwp/icon-d2/grib/';
const FETCH_TIMEOUT_MS = 180_000;
const GRIB_CAP_BYTES = 32 * 1024 * 1024; // t_2m regular-lat-lon files are ~1.6 MB
const LISTING_CAP_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_CAP_BYTES = 512 * 1024;
const ALLOWED_PARAMS = ['t_2m'];
const USER_AGENT = 'SATWQ-Reality-OS/1.0 (ICON-D2 snapshot pipeline)';

const FILE_RE =
  /icon-d2_germany_regular-lat-lon_single-level_(\d{10})_(\d{3})_2d_([a-z0-9_]+)\.grib2\.bz2/g;

const fail = (message) => {
  console.error(`[icon-d2-snapshot] FATAL: ${message}`);
  process.exit(1);
};

const usage = () => `Usage: node scripts/icon-d2-snapshot.mjs [options]
  --run HH            model run hour 00..23 (default: newest run containing every horizon)
  --horizons CSV      forecast hours, comma-separated ints 0..48 (default: 0,6,12,24)
  --bin-deg FLOAT     snapshot grid bin size in degrees, 0.05..2 (default: 0.25)
  --param NAME        GRIB parameter (default: t_2m; allowed: ${ALLOWED_PARAMS.join(', ')})
  --dry-run           run the full pipeline but do not touch the GitHub release
  --out-dir PATH      snapshot output directory (default: /tmp/icon-d2-snap)`;

/** Strict argv parsing: unknown flags and bad values exit 2 with usage. */
export function parseArgs(argv) {
  const opts = {
    run: null,
    horizons: [0, 6, 12, 24],
    binDeg: 0.25,
    param: 't_2m',
    dryRun: false,
    outDir: '/tmp/icon-d2-snap',
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
    if (arg === '--run') {
      const v = next();
      if (!/^(0\d|1\d|2[0-3])$/.test(v))
        throw new Error(`--run must be HH 00..23, got "${v}"`);
      opts.run = v;
    } else if (arg === '--horizons') {
      const parts = next().split(',');
      if (parts.length === 0)
        throw new Error('--horizons needs at least one hour');
      opts.horizons = parts.map((p) => {
        if (!/^\d+$/.test(p)) throw new Error(`bad horizon "${p}"`);
        const h = Number(p);
        if (h < 0 || h > 48)
          throw new Error(`horizon out of range 0..48: ${h}`);
        return h;
      });
      opts.horizons = [...new Set(opts.horizons)].sort((a, b) => a - b);
    } else if (arg === '--bin-deg') {
      const raw = next();
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0.05 || v > 2) {
        throw new Error(`--bin-deg must be 0.05..2, got "${raw}"`);
      }
      opts.binDeg = v;
    } else if (arg === '--param') {
      const v = next();
      if (!ALLOWED_PARAMS.includes(v)) {
        throw new Error(
          `--param must be one of ${ALLOWED_PARAMS.join(', ')}, got "${v}"`,
        );
      }
      opts.param = v;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
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

/** Extract 2-digit run dirs from the grib/ index, newest first. */
export function parseRunDirs(html) {
  const dirs = [
    ...new Set([...html.matchAll(/href="(\d{2})\/"/g)].map((m) => m[1])),
  ];
  return dirs.sort().reverse();
}

/**
 * Extract {runDate, horizon, file} rows for one param dir listing.
 * runDate is the 10-digit run init stamp (YYYYMMDDHH), horizon the 3-digit
 * forecast hour.
 */
export function parseParamFiles(html, param) {
  const rows = [];
  for (const m of html.matchAll(FILE_RE)) {
    if (m[3] !== param) continue;
    rows.push({ runDate: m[1], horizon: Number(m[2]), file: m[0] });
  }
  return rows;
}

/**
 * Pick the newest run (by runDate) that contains every requested horizon.
 * Returns {runDate, files: Map<horizon, file>} or null.
 */
export function selectRun(rows, horizons) {
  const byRun = new Map();
  for (const r of rows) {
    if (!byRun.has(r.runDate)) byRun.set(r.runDate, new Map());
    byRun.get(r.runDate).set(r.horizon, r.file);
  }
  const runDates = [...byRun.keys()].sort().reverse();
  for (const runDate of runDates) {
    const have = byRun.get(runDate);
    if (horizons.every((h) => have.has(h))) return { runDate, files: have };
  }
  return null;
}

function runDateToIso(runDate) {
  // "2026092621" → "2026-09-26T21:00:00Z"
  return `${runDate.slice(0, 4)}-${runDate.slice(4, 6)}-${runDate.slice(6, 8)}T${runDate.slice(8, 10)}:00:00Z`;
}

function checkBzip2() {
  try {
    execFileSync('bzip2', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    fail(
      'bzip2 binary not found on PATH — required to decompress DWD .grib2.bz2 files',
    );
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[icon-d2-snapshot] ${error.message}\n${usage()}`);
    process.exit(2);
  }
  console.log(
    `[icon-d2-snapshot] param=${opts.param} horizons=${opts.horizons.join(',')} bin=${opts.binDeg}deg` +
      (opts.dryRun ? ' DRY-RUN (no release publish)' : ''),
  );
  checkBzip2();

  console.log('[icon-d2-snapshot] listing model runs…');
  const runHtml = (
    await readCapped(
      await fetchWithTimeout(BASE_URL, { accept: 'text/html' }).catch((e) =>
        fail(`run listing failed: ${e.message}`),
      ),
      LISTING_CAP_BYTES,
    )
  ).toString('utf8');
  const runDirs = parseRunDirs(runHtml);
  if (!runDirs.length)
    fail('no run directories found in DWD ICON-D2 grib index');
  const wantedRuns = opts.run ? [opts.run] : runDirs;
  if (opts.run && !runDirs.includes(opts.run)) {
    fail(
      `requested run ${opts.run} not present in DWD index (have: ${runDirs.slice(0, 8).join(',')}…)`,
    );
  }

  // Scan candidate runs newest-first for the first one holding every horizon.
  let selected = null;
  let paramBase = null;
  for (const runDir of wantedRuns) {
    paramBase = `${BASE_URL}${runDir}/${opts.param}/`;
    console.log(`[icon-d2-snapshot] scanning run ${runDir}…`);
    const html = (
      await readCapped(
        await fetchWithTimeout(paramBase, { accept: 'text/html' }).catch((e) =>
          fail(`param listing failed for run ${runDir}: ${e.message}`),
        ),
        LISTING_CAP_BYTES,
      )
    ).toString('utf8');
    const rows = parseParamFiles(html, opts.param);
    if (!rows.length) {
      console.log(
        `[icon-d2-snapshot] run ${runDir}: no ${opts.param} files, skipping`,
      );
      continue;
    }
    selected = selectRun(rows, opts.horizons);
    if (selected) break;
    console.log(
      `[icon-d2-snapshot] run ${runDir}: incomplete horizons, trying older run`,
    );
  }
  if (!selected)
    fail(`no run contains all requested horizons (${opts.horizons.join(',')})`);
  const runIso = runDateToIso(selected.runDate);
  console.log(
    `[icon-d2-snapshot] selected run ${selected.runDate} (${runIso}), horizons: ${opts.horizons.join(',')}`,
  );

  const fetchedAt = new Date().toISOString();
  const horizons = [];
  for (const h of opts.horizons) {
    const file = selected.files.get(h);
    const url = paramBase + file;
    console.log(
      `[icon-d2-snapshot] downloading f${String(h).padStart(3, '0')}: ${file}`,
    );
    const bz2 = await readCapped(
      await fetchWithTimeout(url, { accept: 'application/octet-stream' }).catch(
        (e) => fail(`GRIB download failed for ${file}: ${e.message}`),
      ),
      GRIB_CAP_BYTES,
    );
    let grib;
    try {
      grib = execFileSync('bzip2', ['-dc'], {
        input: bz2,
        maxBuffer: GRIB_CAP_BYTES,
      });
    } catch (error) {
      fail(`bzip2 decompress failed for ${file}: ${error.message}`);
    }
    let grid;
    try {
      grid = await decodeWindGribMessage(new Uint8Array(grib));
    } catch (error) {
      fail(`GRIB decode failed for ${file}: ${error.message}`);
    }
    if (grid.shortName !== '2t') {
      fail(
        `unexpected shortName "${grid.shortName}" in ${file} (expected "2t")`,
      );
    }
    const binned = binTemperatureGrid(
      {
        ni: grid.ni,
        nj: grid.nj,
        lo1: grid.lo1,
        la1: grid.la1,
        di: grid.di,
        dj: grid.dj,
        values: grid.values,
      },
      opts.binDeg,
    );
    const validTime = new Date(Date.parse(runIso) + h * 3600_000).toISOString();
    console.log(
      `[icon-d2-snapshot] f${h}: ${grid.ni}x${grid.nj} → ${binned.nx}x${binned.ny} ` +
        `(${binned.pointCount} cells), t2m mean ${(binned.stats.mean - 273.15).toFixed(1)}°C, valid ${validTime}`,
    );
    horizons.push({ forecastHour: h, validTime, grid: binned });
  }

  let snapshot;
  try {
    snapshot = buildIconD2Snapshot({
      run: runIso,
      fetchedAt,
      param: opts.param,
      units: 'K',
      horizons,
    });
    validateIconD2Snapshot(snapshot);
  } catch (error) {
    fail(`snapshot build/validate failed: ${error.message}`);
  }

  mkdirSync(opts.outDir, { recursive: true });
  const snapPath = path.join(opts.outDir, 'icon-d2-latest.json');
  const metaPath = path.join(opts.outDir, 'icon-d2-meta.json');
  const snapBytes = new TextEncoder().encode(JSON.stringify(snapshot));
  if (snapBytes.length > SNAPSHOT_CAP_BYTES) {
    fail(`snapshot too large for edge: ${snapBytes.length} bytes`);
  }
  writeFileSync(snapPath, snapBytes);
  const meta = {
    pipeline: 'scripts/icon-d2-snapshot.mjs',
    run: selected.runDate,
    runIso,
    param: opts.param,
    horizons: opts.horizons,
    binDeg: opts.binDeg,
    fetchedAt,
    snapshotBytes: snapBytes.length,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // Read-back verification: the bytes we are about to publish must be exactly
  // what the edge provider validates.
  try {
    if (statSync(snapPath).size !== snapBytes.length) {
      throw new Error('icon-d2-latest.json size mismatch on read-back');
    }
    const back = JSON.parse(readFileSync(snapPath, 'utf8'));
    validateIconD2Snapshot(back);
    if (back.run !== runIso) throw new Error('run mismatch on read-back');
  } catch (error) {
    fail(`snapshot verification failed: ${error.message}`);
  }
  console.log(
    `[icon-d2-snapshot] snapshot verified locally (${snapBytes.length} bytes).`,
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
    console.log('[icon-d2-snapshot] dry-run: skipping release publish.');
    console.log(`[icon-d2-snapshot] files: ${snapPath}, ${metaPath}`);
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
    console.log(`[icon-d2-snapshot] creating release ${TAG}…`);
    try {
      runGh(
        'release',
        'create',
        TAG,
        '--title',
        'ICON-D2 2 m temperature snapshot (latest)',
        '--notes',
        'Latest pre-binned DWD ICON-D2 2 m temperature snapshot for the Cloudflare Pages deploy. ' +
          'Refreshed by scripts/icon-d2-snapshot.mjs; icon-d2-latest.json holds binned t_2m grids ' +
          'for several forecast horizons. Source data: Deutscher Wetterdienst (DWD) open data.',
      );
    } catch (error) {
      fail(error.message);
    }
  }
  console.log('[icon-d2-snapshot] uploading assets (--clobber)…');
  try {
    runGh('release', 'upload', TAG, snapPath, metaPath, '--clobber');
  } catch (error) {
    fail(error.message);
  }
  const base = `https://github.com/${REPO}/releases/download/${TAG}`;
  console.log('[icon-d2-snapshot] published:');
  console.log(`  ${base}/icon-d2-latest.json`);
  console.log(`  ${base}/icon-d2-meta.json`);
  return { published: true };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  await main();
}
