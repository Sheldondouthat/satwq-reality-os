import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  animateStatValue,
  easeOutCubic,
  formatCompact,
  formatInt,
} from './layerStatsTicker.js';

/** Manual rAF stub: test drives time explicitly. */
function makeRaf() {
  let nowMs = 0;
  const pending = [];
  return {
    frame(cb) {
      pending.push(cb);
    },
    /** Run the callbacks pending at entry, at time t (ms). Newly queued
     *  callbacks wait for the next at() — otherwise a rAF loop that
     *  re-queues itself would spin forever inside one at(). */
    at(t) {
      nowMs = t;
      const run = pending.splice(0);
      for (const cb of run) cb(nowMs);
    },
    pending: () => pending.length,
  };
}

function makeEl() {
  return { textContent: '', classList: { add() {}, remove() {} } };
}

test('easeOutCubic hits the anchors and eases out', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  // Easing out: more than half the distance covered in the first half.
  assert.ok(easeOutCubic(0.5) > 0.5);
});

test('formatCompact compacts thousands/millions/billions', () => {
  assert.equal(formatCompact(0), '0');
  assert.equal(formatCompact(999), '999');
  assert.equal(formatCompact(1200), '1.2K');
  assert.equal(formatCompact(2500000), '2.5M');
  assert.equal(formatCompact(1300000000), '1.3B');
  assert.equal(formatCompact(-4500), '-4.5K');
  assert.equal(formatCompact(NaN), '—');
});

test('formatInt groups thousands', () => {
  assert.equal(formatInt(1234567), '1,234,567');
  assert.equal(formatInt(42), '42');
  assert.equal(formatInt(NaN), '—');
});

test('animateStatValue ramps from start to exact end over duration', () => {
  const raf = makeRaf();
  const el = makeEl();
  animateStatValue(el, 0, 1000, { duration: 600, frame: raf.frame });
  raf.at(0);
  assert.equal(el.textContent, '0');
  raf.at(300); // half time → eased past half the value
  const parse = (t) => (t.endsWith('K') ? Number(t.slice(0, -1)) * 1000 : Number(t));
  assert.ok(parse(el.textContent) > 500, `expected eased midpoint > 500, got ${el.textContent}`);
  raf.at(600);
  assert.equal(el.textContent, '1K'); // exact target
  assert.equal(raf.pending(), 0); // loop finished, nothing queued
});

test('animateStatValue with zero duration lands immediately', () => {
  const raf = makeRaf();
  const el = makeEl();
  animateStatValue(el, 0, 500, { duration: 0, frame: raf.frame });
  raf.at(0);
  assert.equal(el.textContent, '500');
});

test('cancel() stops further frames', () => {
  const raf = makeRaf();
  const el = makeEl();
  const cancel = animateStatValue(el, 0, 1000, { duration: 600, frame: raf.frame });
  raf.at(0);
  cancel();
  raf.at(600);
  assert.equal(el.textContent, '0');
});
