#!/usr/bin/env node
/**
 * Build and publish the NOAA GloTEC ionosphere snapshot for the Pages deploy.
 *
 * The live GloTEC GeoJSON (2.4 MB, 5184 points, ~10 min cadence) is too heavy
 * to pull through the edge on every cache miss, so the /api/tec provider
 * (server/providers/wave7/tec.js) serves a pre-downsampled snapshot instead.
 * THIS script is the only place the 2.4 MB file is ever downloaded: it runs
 * on a machine with normal egress, picks the newest glotec_icao_*.geojson
 * from https://services.swpc.noaa.gov/products/glotec/geojson_2d_urt/,
 * downsamples it to a 36x36 grid via buildTecSnapshot(), validates the
 * result, and publishes it to the `tec-latest` GitHub release on
 * Sheldondouthat/satwq-reality-os:
 *
 *   tec-latest.json — {format, upstreamFile, fetchedAt, stats, grid:{lon,lat,tec,anomaly,hmF2,nmF2}}
 *   tec-meta.json   — provenance for the snapshot pipeline itself
 *
 * ANY failure exits non-zero BEFORE the release is touched, so the last good
 * snapshot stays live. This script never writes synthetic TEC data: if the
 * SWPC upstream is unreachable it reports the exact error and exits 1.
 *
 * Usage: node scripts/tec-snapshot.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildTecSnapshot, validateTecSnapshot } from '../server/providers/wave7/tec.js';

const REPO = 'Sheldondouthat/satwq-reality-os';
const TAG = 'tec-latest';
const SNAP_DIR = '/tmp/tec-snap';
const DIR_URL = 'https://services.swpc.noaa.gov/products/glotec/geojson_2d_urt/';
const FETCH_TIMEOUT_MS = 180_000;
const GEOJSON_CAP_BYTES = 8 * 1024 * 1024; // upstream is ~2.4 MB; 8 MB is a hard ceiling

const fail = (message) => {
  console.error(`[tec-snapshot] FATAL: ${message}`);
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

async function fetchWithTimeout(url, { accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('fetch timed out')), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'SATWQ-Reality-OS/1.0 (GloTEC snapshot pipeline)', Accept: accept ?? '*/*' },
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
    throw new Error(`declared content-length ${declared} exceeds cap ${capBytes}`);
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > capBytes) throw new Error('body exceeds cap');
    return text;
  }
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > capBytes) {
      try { await reader.cancel(); } catch { /* no-op */ }
      throw new Error(`body exceeded cap ${capBytes} bytes`);
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

async function main() {
  console.log('[tec-snapshot] listing GloTEC directory…');
  const listing = await readCapped(
    await fetchWithTimeout(DIR_URL, { accept: 'text/html' }),
    512 * 1024,
  ).catch((error) => fail(`directory listing failed: ${error.message}`));

  const names = [
    ...new Set([...listing.matchAll(/glotec_icao_(\d{8}T\d{6}Z)\.geojson/g)].map((m) => m[0])),
  ].sort();
  if (!names.length) fail('no glotec_icao_*.geojson files found in directory listing');
  const newest = names[names.length - 1];
  const fileUrl = DIR_URL + newest;
  console.log(`[tec-snapshot] newest file: ${newest} (${names.length} files listed)`);

  console.log('[tec-snapshot] downloading GeoJSON…');
  const geoJsonText = await readCapped(
    await fetchWithTimeout(fileUrl, { accept: 'application/geo+json, application/json' }),
    GEOJSON_CAP_BYTES,
  ).catch((error) => fail(`GeoJSON download failed: ${error.message}`));

  const fetchedAt = new Date().toISOString();
  let snapshot;
  try {
    snapshot = buildTecSnapshot(geoJsonText, { upstreamFile: newest, upstreamUrl: fileUrl, fetchedAt });
    validateTecSnapshot(snapshot);
  } catch (error) {
    fail(`snapshot build/validate failed: ${error.message}`);
  }
  console.log(
    `[tec-snapshot] built: ${snapshot.pointCount} pts → ${snapshot.gridPoints} grid pts, ` +
      `TEC max ${snapshot.stats.tec.max.toFixed(2)} TECU, anomaly max ${snapshot.stats.anomaly.max.toFixed(2)}`,
  );

  mkdirSync(SNAP_DIR, { recursive: true });
  const snapPath = path.join(SNAP_DIR, 'tec-latest.json');
  const metaPath = path.join(SNAP_DIR, 'tec-meta.json');
  const snapBytes = new TextEncoder().encode(JSON.stringify(snapshot));
  if (snapBytes.length > 512 * 1024) fail(`snapshot too large for edge: ${snapBytes.length} bytes`);
  writeFileSync(snapPath, snapBytes);
  const meta = {
    pipeline: 'scripts/tec-snapshot.mjs',
    upstreamFile: newest,
    upstreamUrl: fileUrl,
    fetchedAt,
    pointCount: snapshot.pointCount,
    gridPoints: snapshot.gridPoints,
    snapshotBytes: snapBytes.length,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // Read-back verification: the bytes we are about to publish must be exactly
  // what the edge provider validates.
  try {
    if (statSync(snapPath).size !== snapBytes.length) throw new Error('tec-latest.json size mismatch on read-back');
    const back = JSON.parse(readFileSync(snapPath, 'utf8'));
    validateTecSnapshot(back);
    if (back.upstreamFile !== newest) throw new Error('upstreamFile mismatch on read-back');
  } catch (error) {
    fail(`snapshot verification failed: ${error.message}`);
  }
  console.log('[tec-snapshot] snapshot verified locally.');

  // ---- From here on every step mutates the release; all prior steps passed.
  let releaseExists = true;
  try {
    gh('release', 'view', TAG);
  } catch {
    releaseExists = false;
  }
  if (!releaseExists) {
    console.log(`[tec-snapshot] creating release ${TAG}…`);
    try {
      gh(
        'release',
        'create',
        TAG,
        '--title',
        'GloTEC ionosphere snapshot (latest)',
        '--notes',
        'Latest pre-downsampled NOAA SWPC GloTEC ionosphere snapshot for the Cloudflare Pages deploy. ' +
          'Refreshed by scripts/tec-snapshot.mjs; tec-latest.json holds a 36x36 grid of TEC/anomaly/hmF2/NmF2. ' +
          'Source data: NOAA SWPC GloTEC (public domain).',
      );
    } catch (error) {
      fail(error.message);
    }
  }
  console.log('[tec-snapshot] uploading assets (--clobber)…');
  try {
    gh('release', 'upload', TAG, snapPath, metaPath, '--clobber');
  } catch (error) {
    fail(error.message);
  }
  const base = `https://github.com/${REPO}/releases/download/${TAG}`;
  console.log('[tec-snapshot] published:');
  console.log(`  ${base}/tec-latest.json`);
  console.log(`  ${base}/tec-meta.json`);
}

await main();
