/**
 * Conjunction frontend tests — REAL assertions: SGP4 propagation of a
 * constructed TLE, countdown math, risk tiers, CSV-independent coercion,
 * and source orchestration. index.js (Cesium/DOM) is not imported.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coerceConjunction,
  riskTier,
  formatCountdown,
  tcaPosition,
  convergenceArc,
  rankConjunctions,
} from './model.js';
import { createConjunctionSource } from './source.js';

function checksum68(line68) {
  let sum = 0;
  for (const c of line68) {
    if (c >= '0' && c <= '9') sum += Number(c);
    else if (c === '-') sum += 1;
  }
  return String(sum % 10);
}
function makeTle() {
  const l1body = '1 25544U 98067A   26270.50000000  .00002174  00000-0  12345-6 0  999';
  const l2body = '2 25544  51.6400 208.9163 0006703  69.9862  25.2906 15.72125391' + '00001';
  // pad bodies to 68 chars the honest way: count first
  const l1 = l1body.padEnd(68, ' ');
  const l2 = l2body.padEnd(68, ' ');
  if (l1.length !== 68 || l2.length !== 68) throw new Error(`bad tle ${l1.length}/${l2.length}`);
  return { name: 'ISS (ZARYA)', line1: l1 + checksum68(l1), line2: l2 + checksum68(l2) };
}

const RAW = {
  id: 'socrates-25544-48274-2026-09-28T14:22:10.000Z',
  tcaUtc: '2026-09-28T14:22:10.000Z',
  noradId1: '25544', noradId2: '48274',
  name1: 'ISS (ZARYA)', ops1: '+', name2: 'TIANHE', ops2: null,
  minRangeKm: 0.42, relSpeedKms: 11.3, maxProb: 2.5e-5,
  dse1: 1.2, dse2: 0.8, tle1: makeTle(), tle2: makeTle(),
};

test('coerceConjunction keeps a good event, drops garbage', () => {
  const ev = coerceConjunction(RAW);
  assert.equal(ev.tcaMs, Date.parse('2026-09-28T14:22:10.000Z'));
  assert.equal(ev.tle1.line1[0], '1');
  assert.equal(coerceConjunction({ ...RAW, minRangeKm: 5.1 }), null); // outside the wall
  assert.equal(coerceConjunction({ ...RAW, tcaUtc: 'nope' }), null);
  assert.equal(coerceConjunction(null), null);
});

test('riskTier escalates on probability and miss distance', () => {
  assert.equal(riskTier(coerceConjunction({ ...RAW, maxProb: 2e-4 })).key, 'critical');
  assert.equal(riskTier(coerceConjunction({ ...RAW, maxProb: 1e-9, minRangeKm: 0.3 })).key, 'critical');
  assert.equal(riskTier(coerceConjunction({ ...RAW, maxProb: 2.5e-5, minRangeKm: 0.8 })).key, 'high');
  assert.equal(riskTier(coerceConjunction({ ...RAW, maxProb: 1e-9, minRangeKm: 4.9 })).key, 'watch');
});

test('formatCountdown renders T-minus and T-plus', () => {
  const tca = Date.parse('2026-09-28T14:22:10.000Z');
  assert.equal(formatCountdown(tca, tca - (2 * 86400_000 + 4 * 3600_000 + 11 * 60_000 + 33_000)), 'T-2d 04:11:33');
  assert.ok(formatCountdown(tca, tca + 5000).startsWith('T+'));
});

test('tcaPosition propagates a real TLE to a sane geodetic fix', () => {
  const tle = makeTle();
  const pos = tcaPosition(tle, Date.parse('2026-09-27T12:00:00.000Z'));
  assert.ok(pos, 'propagation must succeed');
  assert.ok(Math.abs(pos.lat) <= 51.7, `lat ${pos.lat} within inclination`);
  assert.ok(Math.abs(pos.lon) <= 180);
  assert.ok(pos.altKm > 300 && pos.altKm < 400, `alt ${pos.altKm} km matches the fixture orbit`);
  assert.equal(tcaPosition({ line1: 'junk', line2: 'junk' }, Date.now()), null);
});

test('convergenceArc lifts between the two TCA positions', () => {
  const a = { lat: 10, lon: 20, altKm: 420 };
  const b = { lat: 10.01, lon: 20.01, altKm: 421 };
  const arc = convergenceArc(a, b, { segments: 16 });
  assert.equal(arc.length, 17);
  const mid = arc[8];
  assert.ok(mid[2] > 421 * 1000, 'mid-arc is lifted');
  assert.equal(arc[16][2], 421 * 1000);
});

test('rankConjunctions sorts by probability then miss distance', () => {
  const evs = [
    coerceConjunction({ ...RAW, id: 'a', maxProb: 1e-9, minRangeKm: 0.1 }),
    coerceConjunction({ ...RAW, id: 'b', maxProb: 1e-4, minRangeKm: 4.0 }),
    coerceConjunction({ ...RAW, id: 'c', maxProb: 1e-4, minRangeKm: 0.2 }),
  ];
  const ranked = rankConjunctions(evs).map((e) => e.id);
  assert.deepEqual(ranked, ['c', 'b', 'a']);
});

test('createConjunctionSource coerces via injected fetch', async () => {
  const payload = {
    events: [RAW, { ...RAW, id: 'bad', minRangeKm: 'far' }],
    topByProbability: [RAW.id],
    fetchedAt: '2026-09-27T00:00:00.000Z',
    honesty: 'test',
  };
  const fetchImpl = async () => ({ ok: true, json: async () => payload });
  const snap = await createConjunctionSource({ fetchImpl }).getConjunctions();
  assert.equal(snap.events.length, 1);
  assert.deepEqual(snap.topByProbability, [RAW.id]);
  assert.equal(snap.honesty, 'test');
});

test('createConjunctionSource throws on malformed proxy response', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ events: 'nope' }) });
  await assert.rejects(() => createConjunctionSource({ fetchImpl }).getConjunctions(), /Malformed/);
});
