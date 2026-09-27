#!/usr/bin/env node
/**
 * Build and publish the GFS 10 m wind snapshot for the Cloudflare Pages deploy.
 *
 * The Pages Functions bundle cannot include @meri-imperiumi/eccodes-wasm
 * (esbuild chokes on its node:fs/node:path requires), so the Pages wind
 * provider serves a pre-decoded snapshot instead of decoding GRIB2 at the
 * edge. THIS script is the only place GRIB decoding happens: it runs on a
 * machine with the WASM module, fetches the current GFS 10 m wind field via
 * fetchGfsWind + decodeWindGribMessage, and publishes two assets to the
 * `wind-latest` GitHub release on Sheldondouthat/satwq-reality-os:
 *
 *   gfs.bin       — nx*ny*8 bytes: u Float32 LE..., then v Float32 LE...
 *   gfs-meta.json — {cycle, level, units, grid:{nx,ny,lo1,la1,dx,dy}, generatedAt}
 *
 * ANY failure exits non-zero BEFORE the release is touched, so the last good
 * snapshot stays live. This script never writes synthetic wind data: if the
 * GFS upstream is unreachable it reports the exact error and exits 1.
 *
 * Usage: node scripts/wind-snapshot.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fetchGfsWind } from '../server/providers/wind/gfs.js';
import { decodeWindGribMessage } from '../server/providers/wind/decode.js';

const REPO = 'Sheldondouthat/satwq-reality-os';
const TAG = 'wind-latest';
const SNAP_DIR = '/tmp/wind-snap';
const FETCH_TIMEOUT_MS = 180_000;

const fail = (message) => {
  console.error(`[wind-snapshot] FATAL: ${message}`);
  process.exit(1);
};

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

function validateGrid(grid) {
  const count = grid.nx * grid.ny;
  const problems = [];
  if (
    !Number.isInteger(grid.nx) ||
    !Number.isInteger(grid.ny) ||
    grid.nx < 1 ||
    grid.ny < 1 ||
    count > 1_000_000
  )
    problems.push('bad grid dimensions');
  if (
    ![grid.lo1, grid.la1, grid.dx, grid.dy].every(Number.isFinite) ||
    grid.dx <= 0 ||
    grid.dy <= 0
  )
    problems.push('bad grid geometry');
  if (Math.abs(grid.nx * grid.dx - 360) > 0.01)
    problems.push('grid does not span 360 degrees of longitude');
  for (const [name, values] of [
    ['u', grid.u],
    ['v', grid.v],
  ]) {
    if (
      !(values instanceof Float32Array) ||
      values.length !== count ||
      !values.every(Number.isFinite)
    )
      problems.push(`invalid ${name} component`);
  }
  if (problems.length) throw new Error(`Invalid wind grid: ${problems.join('; ')}`);
  return count;
}

function float32LeBytes(values) {
  // Float32Array stores in platform endianness; x86-64/ARM64 are little-endian.
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

async function main() {
  console.log('[wind-snapshot] fetching GFS 10 m wind (targetDx=1, overlay=none)…');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('GFS fetch timed out')), FETCH_TIMEOUT_MS);
  let snapshot;
  try {
    snapshot = await fetchGfsWind({
      targetDx: 1,
      overlay: 'none',
      decodeImpl: decodeWindGribMessage,
      signal: controller.signal,
    });
  } catch (error) {
    fail(`GFS upstream fetch/decode failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  const { grid, cycle, level, units } = snapshot;
  let count;
  try {
    count = validateGrid(grid);
  } catch (error) {
    fail(error.message);
  }
  console.log(
    `[wind-snapshot] decoded ${grid.nx}x${grid.ny} (${count} pts), ` +
      `cycle ${cycle.date} ${String(cycle.hour).padStart(2, '0')}Z f${cycle.forecastHour}`,
  );

  mkdirSync(SNAP_DIR, { recursive: true });
  const binPath = path.join(SNAP_DIR, 'gfs.bin');
  const metaPath = path.join(SNAP_DIR, 'gfs-meta.json');
  const bin = Buffer.concat([float32LeBytes(grid.u), float32LeBytes(grid.v)]);
  if (bin.length !== count * 8) fail(`byte budget mismatch: ${bin.length} !== ${count * 8}`);
  const meta = {
    cycle,
    level,
    units,
    grid: {
      nx: grid.nx,
      ny: grid.ny,
      lo1: grid.lo1,
      la1: grid.la1,
      dx: grid.dx,
      dy: grid.dy,
    },
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(binPath, bin);
  writeFileSync(metaPath, JSON.stringify(meta));

  // Read-back verification: the bytes we are about to publish must be exactly
  // what the Pages provider and the frontend contract expect.
  try {
    if (statSync(binPath).size !== count * 8)
      throw new Error('gfs.bin size mismatch on read-back');
    const metaBack = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (
      metaBack.grid.nx !== grid.nx ||
      metaBack.grid.ny !== grid.ny ||
      !Number.isFinite(Date.parse(metaBack.generatedAt))
    )
      throw new Error('gfs-meta.json failed read-back validation');
    // readFileSync returns a Buffer whose backing store may be pooled; copy
    // the exact slice before interpreting as Float32.
    const exact = Buffer.from(readFileSync(binPath));
    const values = new Float32Array(exact.buffer, exact.byteOffset, count * 2);
    if (values.length !== count * 2 || !values.every(Number.isFinite))
      throw new Error('gfs.bin values failed read-back validation');
  } catch (error) {
    fail(`snapshot verification failed: ${error.message}`);
  }
  console.log('[wind-snapshot] snapshot verified locally.');

  // ---- From here on every step mutates the release; all prior steps passed.
  let releaseExists = true;
  try {
    gh('release', 'view', TAG);
  } catch {
    releaseExists = false;
  }
  if (!releaseExists) {
    console.log(`[wind-snapshot] creating release ${TAG}…`);
    try {
      gh(
        'release',
        'create',
        TAG,
        '--title',
        'Wind snapshot (latest)',
        '--notes',
        'Latest pre-decoded GFS 10 m wind snapshot for the Cloudflare Pages deploy. ' +
          'Refreshed by scripts/wind-snapshot.mjs; gfs.bin holds nx*ny*8 Float32 LE bytes [u..., v...].',
      );
    } catch (error) {
      fail(error.message);
    }
  }
  console.log('[wind-snapshot] uploading assets (--clobber)…');
  try {
    gh('release', 'upload', TAG, binPath, metaPath, '--clobber');
  } catch (error) {
    fail(error.message);
  }
  const base = `https://github.com/${REPO}/releases/download/${TAG}`;
  console.log('[wind-snapshot] published:');
  console.log(`  ${base}/gfs.bin`);
  console.log(`  ${base}/gfs-meta.json`);
}

await main();
