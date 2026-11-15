/**
 * Floor tiles tests (pure, no DOM): the Ghost Tiles consumption
 * constitution (Packaging Matrix row 3).
 *
 * The contract under test:
 *  1. The floor is a RECORD, never a feed: its classification vocabulary
 *     has no 'live'; its age derives from the manifest's build
 *     timestamp, and a missing/invalid manifest yields age UNKNOWN.
 *  2. The archive is verified before it is served: SHA-256 AND byte
 *     count must match the Ghost Tiles manifest. A corrupted manifest
 *     hash is a REFUSAL (the falsifier's second leg), as is a single
 *     flipped byte in the archive.
 *  3. The falsifier's first leg, at build level: with no network at
 *     all, the shipped archive + the shipped vendored PMTiles client
 *     decode real tiles whose buildings carry their honesty fields
 *     (height_class / height_source) — proven here by consuming the
 *     archive through the vendored library over byte-range reads,
 *     exactly as the face does through the service worker.
 *  4. The service worker holds the line: the archive enters its floor
 *     cache only through the verify path (never the shell precache),
 *     verification precedes any archive cache write, refusal deletes
 *     and records, ranges are served from the verified entry, and the
 *     floor cache survives activation cleanup.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import {
  FLOOR_TILES_PACKAGE,
  FLOOR_ARCHIVE_NAME,
  parseManifest,
  floorAgeSecondsAt,
  classifyFloor,
  verifyArchive,
  parseRangeHeader,
  formatFloorAge,
} from '../../public/floor-tiles.js';

const ROOT = process.cwd();
const pub = (...parts) => path.join(ROOT, 'public', ...parts);

const manifestJson = JSON.parse(
  readFileSync(pub('floor', 'floor-manifest.json'), 'utf8')
);
const archiveBytes = readFileSync(pub('floor', 'home-region.pmtiles'));
const swSource = readFileSync(pub('sw.js'), 'utf8');
const floorPageSource = readFileSync(pub('floor.html'), 'utf8');

const BUILT_MS = Date.parse(manifestJson.floor_built_at_utc);

test('shipped manifest parses and describes the shipped archive', () => {
  const manifest = parseManifest(manifestJson);
  assert.ok(manifest, 'manifest must parse');
  assert.equal(manifest.archive.name, FLOOR_ARCHIVE_NAME);
  assert.equal(manifest.archive.bytes, archiveBytes.byteLength);
  const digest = createHash('sha256').update(archiveBytes).digest('hex');
  assert.equal(manifest.archive.sha256, digest);
  assert.deepEqual(manifest.layers, ['buildings', 'roads', 'parcels']);
  assert.equal(manifest.sourceCounts.buildings, 2495);
});

test('parseManifest refuses manifests that cannot describe a floor', () => {
  assert.equal(parseManifest(null), null);
  assert.equal(parseManifest({}), null);
  const noHash = structuredClone(manifestJson);
  delete noHash.files[FLOOR_ARCHIVE_NAME].sha256;
  assert.equal(parseManifest(noHash), null);
  const badHash = structuredClone(manifestJson);
  badHash.files[FLOOR_ARCHIVE_NAME].sha256 = 'XYZ';
  assert.equal(parseManifest(badHash), null);
  const badDate = structuredClone(manifestJson);
  badDate.floor_built_at_utc = 'not a date';
  assert.equal(parseManifest(badDate), null);
  const zeroBytes = structuredClone(manifestJson);
  zeroBytes.files[FLOOR_ARCHIVE_NAME].bytes = 0;
  assert.equal(parseManifest(zeroBytes), null);
});

test('floor age derives from the build timestamp, never fetch time', () => {
  const manifest = parseManifest(manifestJson);
  assert.equal(floorAgeSecondsAt(manifest, BUILT_MS), 0);
  assert.equal(floorAgeSecondsAt(manifest, BUILT_MS + 3_600_000), 3600);
  // A clock reading before the build clamps to zero, never negative.
  assert.equal(floorAgeSecondsAt(manifest, BUILT_MS - 5000), 0);
  assert.equal(floorAgeSecondsAt(null, BUILT_MS), null);
  assert.equal(formatFloorAge(3600), '1 h 00 min');
  assert.equal(formatFloorAge(null), 'UNKNOWN');
});

test("the floor's classification vocabulary has no 'live'", () => {
  const manifest = parseManifest(manifestJson);
  for (const now of [BUILT_MS, BUILT_MS + 60_000, BUILT_MS + 86_400_000 * 365]) {
    const c = classifyFloor(manifest, now);
    assert.equal(c.state, 'floor');
    assert.ok(c.ageSeconds >= 0);
  }
  // No manifest → the age is UNKNOWN, stated, never invented.
  assert.deepEqual(classifyFloor(null, BUILT_MS), {
    state: 'unknown',
    ageSeconds: null,
    builtAt: null,
  });
});

test('verifyArchive accepts the shipped archive against its manifest', async () => {
  const manifest = parseManifest(manifestJson);
  const verdict = await verifyArchive(manifest, archiveBytes);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.actual, manifest.archive.sha256);
});

test('verifyArchive REFUSES a corrupted manifest hash (falsifier leg 2)', async () => {
  const tampered = structuredClone(manifestJson);
  // Flip the first hex digit of the manifest's recorded hash.
  const sha = tampered.files[FLOOR_ARCHIVE_NAME].sha256;
  tampered.files[FLOOR_ARCHIVE_NAME].sha256 =
    (sha[0] === '0' ? '1' : '0') + sha.slice(1);
  const manifest = parseManifest(tampered);
  assert.ok(manifest, 'tampered manifest still parses — the hash is well-formed, just wrong');
  const verdict = await verifyArchive(manifest, archiveBytes);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'sha256-mismatch');
});

test('verifyArchive REFUSES a single flipped byte and a truncation', async () => {
  const manifest = parseManifest(manifestJson);
  const flipped = Buffer.from(archiveBytes);
  flipped[200_000] ^= 0xff;
  const flipVerdict = await verifyArchive(manifest, flipped);
  assert.equal(flipVerdict.ok, false);
  assert.equal(flipVerdict.reason, 'sha256-mismatch');
  const truncVerdict = await verifyArchive(
    manifest,
    archiveBytes.subarray(0, archiveBytes.byteLength - 1)
  );
  assert.equal(truncVerdict.ok, false);
  assert.equal(truncVerdict.reason, 'byte-count-mismatch');
});

test('parseRangeHeader serves single ranges and rejects the rest', () => {
  const total = 3_647_868;
  assert.deepEqual(parseRangeHeader('bytes=0-126', total), { start: 0, end: 126 });
  assert.deepEqual(parseRangeHeader('bytes=100-', total), { start: 100, end: total - 1 });
  assert.deepEqual(parseRangeHeader('bytes=-50', total), { start: total - 50, end: total - 1 });
  assert.deepEqual(parseRangeHeader('bytes=99999999-', total), null);
  assert.deepEqual(parseRangeHeader('bytes=0-99999999', total), { start: 0, end: total - 1 });
  assert.equal(parseRangeHeader('bytes=0-1,4-5', total), null);
  assert.equal(parseRangeHeader('items=0-1', total), null);
  assert.equal(parseRangeHeader(null, total), null);
  assert.equal(parseRangeHeader('bytes=0-1', 0), null);
});

test('falsifier leg 1: the vendored client decodes real tiles from the shipped archive, offline', async () => {
  // Load the exact pmtiles.js the face ships, in a sandbox with no
  // network: its only byte source is range reads over the archive.
  const libSource = readFileSync(pub('floor', 'vendor', 'pmtiles.js'), 'utf8');
  const context = vm.createContext({ console });
  vm.runInContext(libSource, context);
  const pmtiles = context.pmtiles;
  assert.ok(pmtiles && pmtiles.PMTiles, 'vendored pmtiles client must load');

  const ab = archiveBytes.buffer.slice(
    archiveBytes.byteOffset,
    archiveBytes.byteOffset + archiveBytes.byteLength
  );
  const rangeSource = {
    getBytes: async (offset, length) => ({
      data: ab.slice(offset, offset + length),
    }),
    getKey: () => 'floor-tiles-test',
  };
  const client = new pmtiles.PMTiles(rangeSource);
  const header = await client.getHeader();
  assert.equal(header.minZoom, 0);
  assert.equal(header.maxZoom, 16);

  // Tile 14/4523/6359 — the tile the floor package's serve test proved
  // carries all three layers.
  const tile = await client.getZxy(14, 4523, 6359);
  assert.ok(tile && tile.data.byteLength > 0, 'tile must return bytes');
  let data = Buffer.from(tile.data);
  if (data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data);
  const vt = new VectorTile(new PbfReader(data));
  assert.deepEqual(Object.keys(vt.layers).sort(), ['buildings', 'parcels', 'roads']);

  const buildings = vt.layers.buildings;
  assert.ok(buildings.length > 0, 'buildings layer must carry features');
  let modeled = 0;
  let estimated = 0;
  for (let i = 0; i < buildings.length; i++) {
    const props = buildings.feature(i).properties;
    assert.ok(
      props.height_class === 'Modeled' || props.height_class === 'ESTIMATED',
      `building ${props.id} lost its height_class in the tiles`
    );
    assert.ok(props.height_source, `building ${props.id} lost its height_source`);
    if (props.height_class === 'Modeled') modeled++;
    else estimated++;
  }
  assert.ok(modeled > 0 && estimated > 0, 'both honesty classes must be present');
});

test('the floor face renders the record grammar, never a live badge', () => {
  assert.ok(floorPageSource.includes('FLOOR RECORD'), 'floor banner grammar missing');
  assert.ok(!floorPageSource.includes("className = 'banner live'"), 'floor face must never wear the live banner');
  assert.ok(floorPageSource.includes('height_class'), 'buildings must be told by height_class');
  assert.ok(floorPageSource.includes(FLOOR_TILES_PACKAGE.id), 'floor package id missing from the face');
});

test('service worker: the archive enters the floor cache only through verification', () => {
  // Not in the shell precache — precaching would bypass the hash check.
  const shellBlock = swSource.slice(
    swSource.indexOf('const SHELL_URLS'),
    swSource.indexOf('];', swSource.indexOf('const SHELL_URLS'))
  );
  assert.ok(!shellBlock.includes('home-region.pmtiles'), 'archive must not be precached unverified');
  for (const url of ['/floor.html', '/floor-tiles.js', '/floor/vendor/pmtiles.js', '/floor/vendor/maplibre-gl.js']) {
    assert.ok(shellBlock.includes(`'${url}'`), `${url} missing from the shell precache`);
  }
  // The floor cache is versioned beside the shell/runtime caches and
  // survives activation cleanup.
  assert.ok(swSource.includes('const FLOOR_CACHE = `satwq-floor-${CACHE_VERSION}`'));
  assert.ok(swSource.includes('key !== FLOOR_CACHE'), 'activation must preserve the floor cache');
});

test('service worker: verification precedes any archive cache write; refusal is recorded', () => {
  const ensureBody = swSource.slice(
    swSource.indexOf('async function ensureFloor'),
    swSource.indexOf('async function floorStatusResponse')
  );
  const digestAt = ensureBody.indexOf('await ghostSha256Hex(buffer)');
  const putAt = ensureBody.indexOf('await cache.put(');
  assert.ok(digestAt > -1, 'ensureFloor must hash the archive bytes');
  assert.ok(putAt > digestAt, 'no cache write may precede the hash check');
  assert.ok(ensureBody.includes('FLOOR REFUSED'), 'refusal must be loud');
  assert.ok(
    ensureBody.includes('await cache.delete(FLOOR_ARCHIVE_URL)'),
    'refusal must drop any held copy'
  );
  assert.ok(swSource.includes("const FLOOR_STATUS_URL = '/floor/floor-status.json'"));
});

test('service worker: ranges are served from the verified entry (206 + Content-Range)', () => {
  assert.ok(swSource.includes("'Content-Range'"), 'range responses must carry Content-Range');
  assert.ok(swSource.includes('status: 206'), 'range responses must be 206');
  assert.ok(swSource.includes('status: 502'), 'an unheld/refused floor must answer 502, never unverified bytes');
});

test('manifest offers the floor as a shortcut beside the river', () => {
  const webmanifest = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8'));
  const urls = (webmanifest.shortcuts || []).map((s) => s.url);
  assert.ok(urls.includes('/floor'), 'floor shortcut missing');
  assert.ok(urls.includes('/river'), 'river shortcut must remain');
});
