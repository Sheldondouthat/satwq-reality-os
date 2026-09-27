/**
 * deepTime model tests — real assertions over pure helpers and the actual
 * bundled slice assets (parsed from disk, no Cesium/DOM needed).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  AGE_SLICES_MA,
  DEEP_TIME_HONESTY,
  DEEP_TIME_MODEL,
  ageLabel,
  nearestSliceAge,
  sliceAssetName,
  validateSlice,
  countSliceVertices,
} from './model.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

describe('deepTime model', () => {
  it('ships exactly the advertised slices, sorted', () => {
    assert.deepEqual(AGE_SLICES_MA, [0, 50, 100, 150, 200, 250, 300]);
  });

  it('labels ages honestly', () => {
    assert.equal(ageLabel(0), 'Present day');
    assert.equal(ageLabel(200), '200 million years ago');
    assert.throws(() => ageLabel(-5), TypeError);
    assert.throws(() => ageLabel('x'), TypeError);
  });

  it('snaps to the nearest bundled slice', () => {
    assert.equal(nearestSliceAge(24), 0);
    assert.equal(nearestSliceAge(26), 50);
    assert.equal(nearestSliceAge(300), 300);
    assert.equal(nearestSliceAge(295), 300);
    assert.throws(() => nearestSliceAge(Number.NaN), TypeError);
  });

  it('names slice assets', () => {
    assert.equal(sliceAssetName(0), 'deep_coast_0Ma.json');
    assert.equal(sliceAssetName(137), 'deep_coast_150Ma.json');
  });

  it('honesty caption discloses model + uncertainty', () => {
    assert.match(DEEP_TIME_HONESTY, /model reconstruction, not observation/i);
    assert.match(DEEP_TIME_HONESTY, new RegExp(DEEP_TIME_MODEL));
    assert.match(DEEP_TIME_HONESTY, /uncertainty/i);
  });

  it('rejects malformed slices', () => {
    assert.equal(validateSlice(null).ok, false);
    assert.equal(validateSlice({}).ok, false);
    assert.equal(validateSlice({ ageMa: 42, model: DEEP_TIME_MODEL, features: [] }).ok, false);
    // wrong plate model rejected
    assert.equal(
      validateSlice({ ageMa: 100, model: 'WRONG_MODEL', features: [{ t: 'P', c: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }] }).ok,
      false,
    );
    // coordinate out of range
    assert.equal(
      validateSlice({ ageMa: 100, model: DEEP_TIME_MODEL, features: [{ t: 'P', c: [[[0, 0], [1, 0], [999, 1], [0, 0]]] }] }).ok,
      false,
    );
    // minimal valid slice
    const good = {
      ageMa: 100, model: DEEP_TIME_MODEL, source: 'x',
      features: [{ t: 'P', c: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }],
    };
    assert.deepEqual(validateSlice(good), { ok: true, reason: null });
    assert.equal(countSliceVertices(good), 4);
  });

  it('every bundled slice asset is valid and renderable', async () => {
    for (const age of AGE_SLICES_MA) {
      const raw = await readFile(path.join(DIR, 'data', sliceAssetName(age)), 'utf8');
      const doc = JSON.parse(raw);
      const check = validateSlice(doc);
      assert.equal(check.ok, true, `slice ${age}Ma invalid: ${check.reason}`);
      const verts = countSliceVertices(doc);
      assert.ok(verts > 1000, `slice ${age}Ma has suspiciously few vertices (${verts})`);
      assert.ok(verts < 400000, `slice ${age}Ma too heavy (${verts})`);
    }
  });

  it('present-day slice actually contains recognizable landmass density', async () => {
    const raw = await readFile(path.join(DIR, 'data', sliceAssetName(0)), 'utf8');
    const doc = JSON.parse(raw);
    assert.ok(doc.features.length > 100, `0Ma features=${doc.features.length}`);
  });

  it('300Ma slice exists (Pangea-era) with fewer, larger features than today', async () => {
    const raw0 = JSON.parse(await readFile(path.join(DIR, 'data', sliceAssetName(0)), 'utf8'));
    const raw300 = JSON.parse(await readFile(path.join(DIR, 'data', sliceAssetName(300)), 'utf8'));
    assert.ok(raw300.features.length < raw0.features.length,
      `expected Pangea consolidation: 300Ma=${raw300.features.length} vs 0Ma=${raw0.features.length}`);
  });
});
