import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cellsFromTileImage,
  createRadarModeledLightningSource,
  createBlitzortungSource,
  DEFAULT_RADAR_TILES,
  BLITZORTUNG_UPGRADE_NOTES,
} from './source.js';

/** Build a synthetic decoded tile image. paint(x,y) → [r,g,b,a]. */
function makeImage(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { width, height, data };
}

const WARM = () => [255, 140, 0, 255]; // orange — convective bin
const GREEN = () => [20, 180, 90, 255]; // stratiform — not convective
const CLEAR = () => [0, 0, 0, 0]; // transparent — no coverage

test('cellsFromTileImage: warm cell found, transparent/cool cells skipped', () => {
  // 8×8 → 4×4 cells of 2×2 px. Only cell (0,0) is warm.
  const img = makeImage(8, 8, (x, y) =>
    x < 2 && y < 2 ? WARM() : x < 4 && y < 2 ? GREEN() : CLEAR(),
  );
  const cells = cellsFromTileImage(img, 2, 3);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].cellId, 'lightning:cell:2:3:0:0');
  assert.equal(cells[0].intensity, 1);
  assert.ok(cells[0].lat >= -90 && cells[0].lat <= 90);
});

test('cellsFromTileImage: malformed image degrades to []', () => {
  assert.deepEqual(cellsFromTileImage(null, 0, 0), []);
  assert.deepEqual(
    cellsFromTileImage({ width: 4, height: 4, data: new Uint8ClampedArray(3) }, 0, 0),
    [],
  );
  // below-threshold warm pixels (1 of 4 px = 0.25 warm but under threshold? no:
  // threshold is 0.02 so this IS convective — use 0 warm for the negative case)
  const noWarm = makeImage(8, 8, () => GREEN());
  assert.deepEqual(cellsFromTileImage(noWarm, 0, 0), []);
});

test('DEFAULT_RADAR_TILES: 16-tile budget, valid z=3 coords', () => {
  assert.equal(DEFAULT_RADAR_TILES.length, 16);
  for (const [x, y] of DEFAULT_RADAR_TILES) {
    assert.ok(Number.isInteger(x) && x >= 0 && x < 8);
    assert.ok(Number.isInteger(y) && y >= 0 && y < 8);
  }
});

/** Fake radar snapshot source. frameMs is mutable to simulate new frames. */
function fakeRadarSource(state) {
  return {
    calls: 0,
    async getSnapshot() {
      this.calls += 1;
      if (state.fail) throw new Error('radar down');
      return {
        template: 'https://tiles.test/{z}/{x}/{y}.png',
        frameTimeMs: state.frameMs,
      };
    },
  };
}

function warmImage() {
  // one warm 2×2 block in an 8×8 tile → exactly one convective cell
  return makeImage(8, 8, (x, y) => (x < 2 && y < 2 ? WARM() : CLEAR()));
}

test('radar-modeled source: strikes sampled, honestly labeled, frame-cached', async () => {
  const state = { frameMs: 111, fail: false };
  const radar = fakeRadarSource(state);
  const fetchedUrls = [];
  const fetchImpl = async (url) => {
    fetchedUrls.push(url);
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  const src = createRadarModeledLightningSource({
    radarSource: radar,
    fetchImpl,
    decodeTileImage: async () => warmImage(),
    tileSet: [
      [0, 0],
      [1, 1],
    ],
    strikesPerBatch: 10,
    nowMs: () => 9999,
    rngSeed: 5,
  });

  const batch1 = await src.getStrikes();
  assert.equal(batch1.length, 10);
  for (const s of batch1) {
    assert.equal(s.modeled, true);
    assert.equal(s.sourceLabel, 'Modeled from radar');
    assert.equal(s.timeMs, 9999);
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lon));
  }
  assert.equal(fetchedUrls.length, 2, 'two tiles fetched on first refresh');
  assert.ok(
    fetchedUrls[0].includes('/3/0/0.png'),
    `tile URL templated: ${fetchedUrls[0]}`,
  );
  assert.equal(src.getCachedCells().length, 2, 'one convective cell per tile');

  // Same radar frame → re-sample only, no new fetches.
  const batch2 = await src.getStrikes();
  assert.equal(batch2.length, 10);
  assert.equal(fetchedUrls.length, 2, 'frame cache: no refetch');
  assert.notDeepEqual(
    batch1.map((s) => s.id),
    batch2.map((s) => s.id),
    'fresh impulse sample each call',
  );

  // New radar frame → tiles refetched.
  state.frameMs = 222;
  await src.getStrikes();
  assert.equal(fetchedUrls.length, 4, 'new frame refetches tiles');
});

test('radar-modeled source: honest failure when radar or tiles are down', async () => {
  // radar down
  const badRadar = fakeRadarSource({ frameMs: 1, fail: true });
  const src1 = createRadarModeledLightningSource({
    radarSource: badRadar,
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    decodeTileImage: async () => warmImage(),
    tileSet: [[0, 0]],
  });
  await assert.rejects(() => src1.getStrikes(), /radar down/);
  assert.match(src1.lastError, /radar down/);

  // all tiles fail
  const src2 = createRadarModeledLightningSource({
    radarSource: fakeRadarSource({ frameMs: 1, fail: false }),
    fetchImpl: async () => ({ ok: false, status: 404 }),
    decodeTileImage: async () => warmImage(),
    tileSet: [
      [0, 0],
      [1, 1],
    ],
  });
  await assert.rejects(() => src2.getStrikes(), /All radar tiles failed/);
});

test('radar-modeled source: cyclone hook adds eyewall cells (best-effort)', async () => {
  const radar = fakeRadarSource({ frameMs: 1, fail: false });
  const src = createRadarModeledLightningSource({
    radarSource: radar,
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    decodeTileImage: async () => makeImage(8, 8, () => CLEAR()), // no radar cells
    tileSet: [[0, 0]],
    getCycloneCenters: async () => [{ lat: 18.5, lon: -65.2, intensity: 0.95 }],
    strikesPerBatch: 4,
    nowMs: () => 7,
    rngSeed: 1,
  });
  const strikes = await src.getStrikes();
  assert.equal(strikes.length, 4);
  assert.ok(
    strikes.every((s) => s.cellId === 'lightning:cyclone:0'),
    'strikes sampled from the cyclone cell',
  );
  assert.ok(
    strikes.every((s) => Math.abs(s.lat - 18.5) < 5),
    'jittered around the cyclone center',
  );

  // failing cyclone hook degrades to radar cells, not a throw
  const radar2 = fakeRadarSource({ frameMs: 1, fail: false });
  const src2 = createRadarModeledLightningSource({
    radarSource: radar2,
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    decodeTileImage: async () => warmImage(),
    tileSet: [[0, 0]],
    getCycloneCenters: async () => {
      throw new Error('cyclones down');
    },
    strikesPerBatch: 2,
  });
  const ok = await src2.getStrikes();
  assert.equal(ok.length, 2);
});

test('radar-modeled source: abort signal honored', async () => {
  const radar = fakeRadarSource({ frameMs: 1, fail: false });
  const src = createRadarModeledLightningSource({
    radarSource: radar,
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    decodeTileImage: async () => warmImage(),
    tileSet: [[0, 0]],
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => src.getStrikes({ signal: controller.signal }));
});

test('blitzortung stub: inert without account, honest with one', async () => {
  const inert = createBlitzortungSource();
  assert.equal(inert.modeled, false);
  const err = await inert.getStrikes().catch((e) => e);
  assert.equal(err.code, 'LIGHTNING_ACCOUNT_REQUIRED');
  assert.match(err.message, /free blitzortung\.org login/);

  const withCreds = createBlitzortungSource({ username: 'u', password: 'p' });
  const err2 = await withCreds.getStrikes().catch((e) => e);
  assert.equal(err2.code, 'LIGHTNING_NOT_IMPLEMENTED');
  assert.match(err2.message, /Refusing to fabricate strikes/);

  assert.ok(Array.isArray(BLITZORTUNG_UPGRADE_NOTES.steps));
  assert.ok(BLITZORTUNG_UPGRADE_NOTES.steps.length >= 4);
  assert.ok(Object.isFrozen(BLITZORTUNG_UPGRADE_NOTES));
});
