/**
 * Fireball frontend tests — REAL assertions on the pure model, shower
 * cross, and source fetch orchestration. index.js (Cesium/DOM) is not
 * imported here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coerceFireball,
  energyClass,
  formatEnergy,
  markerPixels,
  streakPositions,
  highlightReel,
  isRecent,
} from './model.js';
import { activeShowers, showerForFireball, SHOWERS } from './showers.js';
import { createFireballSource } from './source.js';

const RAW = {
  id: 'cneos-2026-09-11T01:12:11.000Z',
  dateUtc: '2026-09-11T01:12:11.000Z',
  energyKt: 24.6,
  impactEnergyKt: 0.67,
  lat: 54.4,
  lon: -100.1,
  altKm: 38.0,
  velKms: null,
  recent: true,
};

test('coerceFireball keeps a good event, drops garbage', () => {
  const ev = coerceFireball(RAW);
  assert.equal(ev.energyKt, 24.6);
  assert.equal(ev.timeMs, Date.parse('2026-09-11T01:12:11.000Z'));
  assert.equal(ev.velKms, null);
  assert.equal(coerceFireball({ ...RAW, lat: 91 }), null);
  assert.equal(coerceFireball({ ...RAW, energyKt: 0 }), null);
  assert.equal(coerceFireball(null), null);
});

test('energyClass thresholds and formatEnergy strings', () => {
  assert.equal(energyClass(0.05).key, 'fizzle');
  assert.equal(energyClass(0.5).key, 'boom');
  assert.equal(energyClass(5).key, 'city');
  assert.equal(energyClass(24.6).key, 'monster');
  assert.equal(formatEnergy(24.6), '24.6 kt TNT');
  assert.equal(formatEnergy(0.05), '50 t TNT');
  assert.equal(formatEnergy(250), '250 kt TNT');
});

test('markerPixels grows logarithmically', () => {
  const small = markerPixels(0.1);
  const big = markerPixels(100);
  assert.ok(big > small);
  assert.ok(big < 5 * small, '1000x energy must stay under 5x pixel growth');
});

test('streakPositions descends from altitude to the surface', () => {
  const ev = coerceFireball(RAW);
  const pts = streakPositions(ev, { segments: 12 });
  assert.equal(pts.length, 13);
  assert.equal(pts[0][2], 38000); // reported 38 km
  assert.equal(pts[12][2], 0);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i][2] < pts[i - 1][2], 'monotonic descent');
});

test('highlightReel sorts newest-first', () => {
  const a = coerceFireball(RAW);
  const b = coerceFireball({ ...RAW, id: 'older', dateUtc: '2020-01-01T00:00:00.000Z' });
  const reel = highlightReel([b, a], 5);
  assert.equal(reel[0].id, a.id);
  assert.ok(isRecent(a, Date.parse('2026-09-20T00:00:00.000Z')));
  assert.ok(!isRecent(b, Date.parse('2026-09-20T00:00:00.000Z')));
});

test('activeShowers finds the Perseids in mid-August, none in March', () => {
  const aug = activeShowers(new Date(Date.UTC(2026, 7, 12)));
  assert.ok(aug.some((s) => s.name === 'Perseids'));
  assert.ok(aug[0].daysFromPeak !== undefined);
  const mar = activeShowers(new Date(Date.UTC(2026, 2, 15)));
  assert.equal(mar.length, 0);
  assert.equal(SHOWERS.length, 8);
});

test('showerForFireball associates by date window only', () => {
  const ev = coerceFireball({ ...RAW, dateUtc: '2026-08-12T03:00:00.000Z' });
  const assoc = showerForFireball(ev);
  assert.equal(assoc.shower, 'Perseids');
  assert.match(assoc.note, /date-window/);
  const off = coerceFireball({ ...RAW, dateUtc: '2026-03-15T03:00:00.000Z' });
  assert.equal(showerForFireball(off), null);
});

test('createFireballSource coerces + sorts via injected fetch', async () => {
  const payload = {
    events: [
      { ...RAW, dateUtc: '2020-01-01T00:00:00.000Z', id: 'old' },
      RAW,
      { ...RAW, id: 'bad', lat: 'nowhere' },
    ],
    fetchedAt: '2026-09-27T00:00:00.000Z',
    honesty: 'test',
  };
  const fetchImpl = async () => ({ ok: true, json: async () => payload });
  const snap = await createFireballSource({ fetchImpl }).getFireballs();
  assert.equal(snap.events.length, 2);
  assert.equal(snap.events[0].id, RAW.id); // newest first
  assert.equal(snap.honesty, 'test');
});

test('createFireballSource throws on malformed proxy response', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ nope: 1 }) });
  await assert.rejects(() => createFireballSource({ fetchImpl }).getFireballs(), /Malformed/);
});
