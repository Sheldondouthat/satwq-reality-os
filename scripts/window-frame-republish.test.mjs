/**
 * window-frame-republish tests — pure parts only (no network, no render).
 * The change rule is the contract: republish when the frame's CONTENT
 * moves (new reading, verdict flip), never for render-volatile fields.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { stableFrameRecord, frameContentChanged } from './window-frame-republish.mjs';
import { bandForMHz } from './window-frame/room-records.mjs';

const base = {
  format: 'gev-window-frame/1',
  room: 'river',
  frame_file: 'river.png',
  data_ts: '2026-11-15T09:30:00.000Z',
  data_epoch: 1794735000,
  rendered_ts: '2026-11-15T09:49:39.000Z',
  rendered_epoch: 1794736179,
  age_at_render_seconds: 1179,
  max_age_seconds: 3600,
  freshness: { verdict: 'CURRENT', basis: 'record fresh at render' },
  values: { stage_ft: 2.93, discharge_cfs: 1380 },
};

test('stableFrameRecord strips exactly the render-volatile fields', () => {
  const s = stableFrameRecord(base);
  assert.equal(s.rendered_ts, undefined);
  assert.equal(s.rendered_epoch, undefined);
  assert.equal(s.age_at_render_seconds, undefined);
  assert.equal(s.data_ts, base.data_ts);
  assert.equal(s.freshness.verdict, 'CURRENT');
});

test('re-render of the same record is NOT a content change', () => {
  const later = {
    ...base,
    rendered_ts: '2026-11-15T10:04:39.000Z',
    rendered_epoch: 1794737079,
    age_at_render_seconds: 2079,
  };
  assert.equal(frameContentChanged(later, base), false);
});

test('a new reading (data_ts + values move) IS a content change', () => {
  const newer = {
    ...base,
    data_ts: '2026-11-15T10:30:00.000Z',
    data_epoch: 1794738600,
    values: { stage_ft: 2.95, discharge_cfs: 1410 },
  };
  assert.equal(frameContentChanged(newer, base), true);
});

test('a verdict flip on the same reading IS a content change', () => {
  const stale = { ...base, freshness: { verdict: 'STALE', basis: 'age crossed max-age' } };
  assert.equal(frameContentChanged(stale, base), true);
});

test('no published frame yet IS a change', () => {
  assert.equal(frameContentChanged(base, null), true);
});

test('key order does not matter', () => {
  const reorder = (v) => {
    if (Array.isArray(v)) return v.map(reorder);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).reverse()) out[k] = reorder(v[k]);
      return out;
    }
    return v;
  };
  assert.equal(frameContentChanged(reorder(base), base), false);
});

/* ---- generic rooms (deck / mind / signals) ---------------------------- */

const roomBase = {
  format: 'gev-window-frame/1',
  room: 'deck',
  frame_file: 'deck.png',
  data_ts: '2026-11-15T14:02:20.000Z',
  data_epoch: 1794753740,
  rendered_ts: '2026-11-15T14:29:46.000Z',
  rendered_epoch: 1794755386,
  age_at_render_seconds: 1646,
  max_age_seconds: 3600,
  freshness: { verdict: 'CURRENT', basis: 'record fresh at render' },
  values: {
    chain_ok: true,
    lines: [{ label: 'HELM TASKS', value: '0 OPEN — NO TASKS BORN YET; THE RIVER IS QUIET' }],
  },
};

test('generic room: re-render of the same record is NOT a content change', () => {
  const later = { ...roomBase, rendered_epoch: 1794756286, age_at_render_seconds: 2546 };
  assert.equal(frameContentChanged(later, roomBase), false);
});

test('generic room: a changed line (a task is born) IS a content change', () => {
  const born = {
    ...roomBase,
    values: {
      ...roomBase.values,
      lines: [{ label: 'HELM TASKS', value: '1 OPEN — RIVER CROSSED CAUTION' }],
    },
  };
  assert.equal(frameContentChanged(born, roomBase), true);
});

test('bandForMHz names the WSPR bands and refuses strangers', () => {
  assert.equal(bandForMHz(14.0971), '20M');
  assert.equal(bandForMHz(10.1402), '30M');
  assert.equal(bandForMHz(7.0401), '40M');
  assert.equal(bandForMHz(144.4905), '2M');
  assert.equal(bandForMHz(9.9999), 'OTHER');
});
