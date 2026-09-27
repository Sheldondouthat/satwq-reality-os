/**
 * WebXR mode tests — REAL assertions (node:test).
 * Pure modules only (math, sprites, sphere mesh); DOM/WebGL paths are
 * fail-soft by construction and not exercised here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  wrapLon,
  lonLatToVec3,
  equirectUV,
  uvToPixel,
  lookDir,
  eyeViewports,
  dragLook,
  viewWindow,
  xrImmersiveSupported,
} from './math.js';
import { incidentToSprite, quakeToSprite, fetchSprites } from './dataSprites.js';
import { buildSphereMesh } from './xrSession.js';

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

describe('math', () => {
  it('wrapLon normalizes to [-180, 180)', () => {
    assert.equal(wrapLon(190), -170);
    assert.equal(wrapLon(-190), 170);
    assert.equal(wrapLon(180), -180);
    assert.equal(wrapLon(45), 45);
  });

  it('lonLatToVec3 produces unit vectors on the sphere', () => {
    for (const [lon, lat] of [[0, 0], [90, 45], [-120, -30], [180, 90]]) {
      const v = lonLatToVec3(lon, lat);
      const len = Math.hypot(v.x, v.y, v.z);
      assert.ok(approx(len, 1), `unit length for ${lon},${lat}`);
    }
    const north = lonLatToVec3(0, 90);
    assert.ok(approx(north.y, 1), 'north pole is +y');
  });

  it('equirectUV maps lon/lat to texture space', () => {
    const c = equirectUV(0, 0);
    assert.ok(approx(c.u, 0.5) && approx(c.v, 0.5));
    const w = equirectUV(-180, 0);
    assert.ok(approx(w.u, 0), `u at dateline west = ${w.u}`);
    assert.deepEqual(uvToPixel(0.5, 0.5, 2048, 1024), { x: 1024, y: 512 });
  });

  it('lookDir points forward at yaw=0 and turns with yaw', () => {
    const f = lookDir(0, 0);
    assert.ok(approx(f.z, -1) && approx(f.x, 0) && approx(f.y, 0));
    const e = lookDir(90, 0);
    assert.ok(approx(e.x, 1) && approx(e.z, 0));
    const up = lookDir(0, 45);
    assert.ok(up.y > 0.7, `pitch up gives +y: ${up.y}`);
  });

  it('eyeViewports splits the framebuffer into left/right halves', () => {
    const vp = eyeViewports(2000, 1000);
    assert.deepEqual(vp.left, { x: 0, y: 0, w: 1000, h: 1000 });
    assert.deepEqual(vp.right, { x: 1000, y: 0, w: 1000, h: 1000 });
  });

  it('dragLook pans yaw/pitch and clamps pitch', () => {
    const next = dragLook({ yawDeg: 0, pitchDeg: 0 }, -40, 20);
    assert.equal(next.yawDeg, 10);
    assert.equal(next.pitchDeg, 5);
    const clamped = dragLook({ yawDeg: 0, pitchDeg: 80 }, 0, 400);
    assert.equal(clamped.pitchDeg, 85);
  });

  it('viewWindow centers on the look direction with wrappable u', () => {
    const win = viewWindow(0, 0, 90, 60);
    assert.ok(approx(win.u1 - win.u0, 0.25));
    assert.ok(approx((win.u0 + win.u1) / 2, 0.5));
    const edge = viewWindow(179, 0, 90, 60);
    assert.ok(edge.u1 > 1, 'window crosses the dateline');
  });

  it('xrImmersiveSupported is false without navigator.xr', async () => {
    assert.equal(await xrImmersiveSupported(undefined), false);
    assert.equal(await xrImmersiveSupported({}), false);
    const fake = { xr: { isSessionSupported: async () => true } };
    assert.equal(await xrImmersiveSupported(fake), true);
    const throwing = { xr: { isSessionSupported: async () => { throw new Error('x'); } } };
    assert.equal(await xrImmersiveSupported(throwing), false);
  });

  it('clamp bounds values', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(99, 0, 10), 10);
  });
});

describe('dataSprites', () => {
  it('incidentToSprite maps severity to color/size', () => {
    const s = incidentToSprite({ lat: 40, lon: -120, severity: 'critical', title: 'Big one' });
    assert.equal(s.color, '#ff5a5a');
    assert.equal(s.size, 14);
    assert.equal(incidentToSprite({ lat: 40 }), null);
    assert.equal(incidentToSprite(null), null);
  });

  it('quakeToSprite thresholds at M4.5 and colors by magnitude', () => {
    const feat = (mag) => ({
      geometry: { coordinates: [-120, 40, 10] },
      properties: { mag, place: 'Testville' },
    });
    assert.equal(quakeToSprite(feat(4.4)), null);
    assert.equal(quakeToSprite(feat(5.0)).color, '#9fc2ff');
    assert.equal(quakeToSprite(feat(5.7)).color, '#ffb347');
    assert.equal(quakeToSprite(feat(6.5)).color, '#ff5a5a');
    assert.ok(quakeToSprite(feat(6.5)).label.startsWith('M6.5'));
  });

  it('fetchSprites never throws and caps count', async () => {
    const fake = async (url) => {
      if (url === '/api/events') {
        return { incidents: Array.from({ length: 10 }, (_, i) => ({ lat: i, lon: i, severity: 'moderate', title: `i${i}` })) };
      }
      throw new Error('network down');
    };
    const sprites = await fetchSprites({ fetchImpl: fake, maxSprites: 5 });
    assert.equal(sprites.length, 5);
    const empty = await fetchSprites({ fetchImpl: async () => { throw new Error('x'); } });
    assert.deepEqual(empty, []);
  });
});

describe('sphere mesh', () => {
  it('buildSphereMesh produces a closed indexed grid', () => {
    const mesh = buildSphereMesh(12, 8, 10);
    assert.equal(mesh.positions.length, (9 * 13) * 3);
    assert.equal(mesh.uvs.length, (9 * 13) * 2);
    assert.equal(mesh.indices.length, 12 * 8 * 6);
    // Vertices lie on the sphere surface.
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const r = Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
      assert.ok(approx(r, 10, 1e-6), `vertex on sphere: ${r}`);
    }
    // UVs span [0,1].
    for (let i = 0; i < mesh.uvs.length; i += 1) {
      assert.ok(mesh.uvs[i] >= 0 && mesh.uvs[i] <= 1, 'uv in range');
    }
  });
});
