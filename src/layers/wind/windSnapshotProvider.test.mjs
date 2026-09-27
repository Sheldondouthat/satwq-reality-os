import assert from 'node:assert/strict';
import test from 'node:test';
import { windSnapshotProxy } from '../../../server/pages/windSnapshot.mjs';

const FIXED_NOW = Date.UTC(2026, 8, 27, 4, 0, 0);

function fixtureMeta(generatedAt = new Date(FIXED_NOW).toISOString()) {
  return {
    cycle: {
      date: '20260927',
      hour: 6,
      forecastHour: 12,
      runIso: '2026-09-27T06:00:00.000Z',
      validIso: '2026-09-27T18:00:00.000Z',
    },
    level: '10 m above ground',
    units: 'm/s',
    grid: { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 60 },
    generatedAt,
  };
}

/** 4x3 grid: u = 1..12, v = 13..24, Float32 LE, u-then-v. */
function fixtureBin() {
  const count = 4 * 3;
  const bytes = new Uint8Array(count * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i += 1) {
    view.setFloat32(i * 4, i + 1, true);
    view.setFloat32((count + i) * 4, count + i + 1, true);
  }
  return bytes;
}

function makeFetchImpl({ meta, bin, fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (fail)
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const u = String(url);
    if (u.endsWith('/gfs-meta.json')) {
      const bytes = new TextEncoder().encode(JSON.stringify(meta ?? fixtureMeta()));
      return { ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer };
    }
    if (u.endsWith('/gfs.bin')) {
      const payload = (bin ?? fixtureBin()).slice();
      return { ok: true, status: 200, arrayBuffer: async () => payload.buffer };
    }
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { fetchImpl, calls };
}

function install(options) {
  const seen = {};
  const plugin = windSnapshotProxy(options);
  assert.equal(plugin.name, 'wind-snapshot');
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        seen.route = route;
        seen.handler = handler;
      },
    },
  });
  assert.equal(seen.route, '/api/wind');
  return seen.handler;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.chunks.push(chunk);
      this.ended = true;
    },
  };
}

async function call(handler, url, method = 'GET') {
  const req = { url, method };
  const res = makeRes();
  await handler(req, res);
  assert.ok(res.ended, `response never ended for ${url}`);
  return res;
}

function jsonBody(res) {
  return JSON.parse(Buffer.concat(res.chunks.map((c) => Buffer.from(c))).toString('utf8'));
}

function rawBody(res) {
  return Buffer.concat(res.chunks.map((c) => Buffer.from(c)));
}

const UNAVAILABLE_GFS = {
  model: 'gfs',
  schemaVersion: 1,
  unavailable: true,
  stale: true,
  reason: 'Wind upstream unavailable',
};

test('manifest satisfies the frontend contract (schemaVersion 1, gridUrl, 360-degree grid)', async () => {
  const { fetchImpl } = makeFetchImpl();
  const handler = install({ fetchImpl, now: () => FIXED_NOW, releaseBase: 'https://x.invalid/r' });
  const res = await call(handler, '/manifest?model=gfs');
  assert.equal(res.statusCode, 200);
  const manifest = jsonBody(res);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.model, 'gfs');
  assert.equal(manifest.unavailable, false);
  assert.equal(manifest.reason, null);
  assert.equal(manifest.stale, false);
  assert.ok(!('overlay' in manifest), 'overlay=none must not set an overlay key');
  assert.deepEqual(manifest.cycle, fixtureMeta().cycle);
  assert.equal(manifest.level, '10 m above ground');
  assert.equal(manifest.units, 'm/s');
  // Exact regex the frontend builds for model=gfs&overlay=none.
  assert.match(
    manifest.gridUrl,
    /^\/api\/wind\/grid\/gfs-[\w.-]+\.bin\?model=gfs$/,
  );
  const { nx, ny, dx } = manifest.grid;
  assert.ok(Math.abs(nx * dx - 360) <= 0.01, 'grid must span 360 degrees');
  assert.equal(nx * ny, 12);
});

test('GET / serves the manifest as well', async () => {
  const { fetchImpl } = makeFetchImpl();
  const handler = install({ fetchImpl, now: () => FIXED_NOW, releaseBase: 'https://x.invalid/r' });
  const res = await call(handler, '/?model=gfs');
  assert.equal(res.statusCode, 200);
  assert.equal(jsonBody(res).unavailable, false);
});

test('grid binary is nx*ny*8 Float32 LE bytes, u then v, all finite', async () => {
  const { fetchImpl } = makeFetchImpl();
  const handler = install({ fetchImpl, now: () => FIXED_NOW, releaseBase: 'https://x.invalid/r' });
  const manifest = jsonBody(await call(handler, '/manifest?model=gfs'));
  const stripped = manifest.gridUrl.replace('/api/wind', '');
  const res = await call(handler, stripped);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/octet-stream');
  const bytes = rawBody(res);
  const { nx, ny } = manifest.grid;
  assert.equal(bytes.length, nx * ny * 8);
  const values = new Float32Array(bytes.buffer, bytes.byteOffset, (nx * ny) * 2);
  assert.ok(values.every(Number.isFinite), 'all grid values must be finite');
  const count = nx * ny;
  for (let i = 0; i < count; i += 1) {
    assert.equal(values[i], i + 1);
    assert.equal(values[count + i], count + i + 1);
  }
});

test('/status omits gridUrl', async () => {
  const { fetchImpl } = makeFetchImpl();
  const handler = install({ fetchImpl, now: () => FIXED_NOW, releaseBase: 'https://x.invalid/r' });
  const res = await call(handler, '/status?model=gfs');
  assert.equal(res.statusCode, 200);
  const status = jsonBody(res);
  assert.ok(!('gridUrl' in status));
  assert.equal(status.unavailable, false);
  assert.equal(status.schemaVersion, 1);
});

test('model=ifs degrades to the exact unavailable shape', async () => {
  const { fetchImpl } = makeFetchImpl();
  const handler = install({ fetchImpl, now: () => FIXED_NOW, releaseBase: 'https://x.invalid/r' });
  const res = await call(handler, '/manifest?model=ifs');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(jsonBody(res), {
    model: 'ifs',
    schemaVersion: 1,
    unavailable: true,
    stale: true,
    reason: 'Wind upstream unavailable',
  });
});

test('overlay!=none degrades to the unavailable shape with the overlay key', async () => {
  const { fetchImpl } = makeFetchImpl();
  const handler = install({ fetchImpl, now: () => FIXED_NOW, releaseBase: 'https://x.invalid/r' });
  const res = await call(handler, '/manifest?model=gfs&overlay=temperature');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(jsonBody(res), {
    ...UNAVAILABLE_GFS,
    overlay: 'temperature',
  });
});

test('snapshot fetch failure degrades to the unavailable shape', async () => {
  const { fetchImpl } = makeFetchImpl({ fail: true });
  const handler = install({ fetchImpl, now: () => FIXED_NOW, releaseBase: 'https://x.invalid/r' });
  const res = await call(handler, '/manifest?model=gfs');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(jsonBody(res), UNAVAILABLE_GFS);
});

test('snapshot older than 12h marks stale but stays available', async () => {
  const old = new Date(FIXED_NOW - 13 * 3600_000).toISOString();
  const { fetchImpl } = makeFetchImpl({ meta: fixtureMeta(old) });
  const handler = install({ fetchImpl, now: () => FIXED_NOW, releaseBase: 'https://x.invalid/r' });
  const res = await call(handler, '/manifest?model=gfs');
  const manifest = jsonBody(res);
  assert.equal(manifest.unavailable, false);
  assert.equal(manifest.stale, true);
});

test('corrupt snapshot (grid size mismatch) degrades to unavailable', async () => {
  const short = fixtureBin().slice(0, 10);
  const { fetchImpl } = makeFetchImpl({ bin: short });
  const handler = install({ fetchImpl, now: () => FIXED_NOW, releaseBase: 'https://x.invalid/r' });
  const res = await call(handler, '/manifest?model=gfs');
  assert.deepEqual(jsonBody(res), UNAVAILABLE_GFS);
});

test('unknown grid id 404s', async () => {
  const { fetchImpl } = makeFetchImpl();
  const handler = install({ fetchImpl, now: () => FIXED_NOW, releaseBase: 'https://x.invalid/r' });
  const res = await call(handler, '/grid/gfs-nope.bin?model=gfs');
  assert.equal(res.statusCode, 404);
  assert.deepEqual(jsonBody(res), { error: 'unknown_grid' });
});

test('unknown model 400s, non-GET 405s, unknown path 404s', async () => {
  const { fetchImpl } = makeFetchImpl();
  const handler = install({ fetchImpl, now: () => FIXED_NOW, releaseBase: 'https://x.invalid/r' });
  assert.deepEqual(jsonBody(await call(handler, '/manifest?model=xyz')), {
    error: 'unknown_model',
  });
  assert.equal((await call(handler, '/manifest?model=xyz')).statusCode, 400);
  const notAllowed = await call(handler, '/manifest?model=gfs', 'POST');
  assert.equal(notAllowed.statusCode, 405);
  const missing = await call(handler, '/nope?model=gfs');
  assert.equal(missing.statusCode, 404);
});

test('snapshot is fetched once per TTL (in-isolate cache)', async () => {
  const { fetchImpl, calls } = makeFetchImpl();
  const handler = install({ fetchImpl, now: () => FIXED_NOW, releaseBase: 'https://x.invalid/r' });
  await call(handler, '/manifest?model=gfs');
  await call(handler, '/manifest?model=gfs');
  await call(handler, '/status?model=gfs');
  assert.deepEqual(calls, [
    'https://x.invalid/r/gfs-meta.json',
    'https://x.invalid/r/gfs.bin',
  ]);
});
