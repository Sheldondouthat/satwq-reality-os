/**
 * Wave 3 Track 2c / 2.11 — RIPEstat tests.
 * Fixtures are real bgp-state rows captured from stat.ripe.net 2026-09-27.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBgpState } from '../../../../server/providers/wave3/ripestat.js';
import {
  RRC_TABLE,
  locateCollectors,
  starArcs,
  pulseSize,
} from './model.js';
import { createRipestatSource } from './source.js';

const REAL_ROWS = [
  { target_prefix: '1.1.1.0/24', source_id: '00-102.208.105.2', path: [328840, 327727, 174, 13335], community: ['64525:10'] },
  { target_prefix: '1.1.1.0/24', source_id: '00-102.217.156.3', path: [328977, 328578, 13335], community: ['13335:10519'] },
  { target_prefix: '1.1.1.0/24', source_id: '01-12.0.1.63', path: [7018, 13335], community: [] },
  { target_prefix: '1.1.1.0/24', source_id: 'bogus', path: [13335], community: [] },
];

function doc(rows) {
  return { data: { resource: '1.1.1.0/24', timestamp: '2026-09-27T03:59:36', bgp_state: rows } };
}

test('parseBgpState distills real bgp-state rows', () => {
  const p = parseBgpState(doc(REAL_ROWS));
  assert.equal(p.prefix, '1.1.1.0/24');
  assert.equal(p.originAsn, 13335); // mode of path tails
  assert.equal(p.totalPeers, 3); // 'bogus' source_id skipped
  assert.equal(p.collectors.length, 2);
  const rrc00 = p.collectors.find((c) => c.rrc === 'rrc00');
  assert.equal(rrc00.peers, 2);
  assert.equal(rrc00.avgPathLen, 3.5);
  assert.deepEqual(rrc00.samplePaths[0], [328840, 327727, 174, 13335]);
});

test('parseBgpState rejects malformed documents', () => {
  assert.throws(() => parseBgpState({}), /bgp_state_not_array/);
  assert.throws(() => parseBgpState({ data: { bgp_state: 'x' } }), /bgp_state_not_array/);
});

test('RRC_TABLE covers every collector id the parser can emit, with sane coords', () => {
  for (const id of Object.keys(RRC_TABLE)) {
    assert.match(id, /^rrc\d{2}$/);
    const s = RRC_TABLE[id];
    assert.ok(s.city && s.ixp, `${id} needs city + ixp`);
    assert.ok(s.lon >= -180 && s.lon <= 180 && s.lat >= -90 && s.lat <= 90, `${id} coords`);
  }
  assert.ok(Object.keys(RRC_TABLE).length >= 20);
  assert.equal(RRC_TABLE.rrc01.city, 'London'); // LINX/LONAP per RIPE ris-docs
  assert.equal(RRC_TABLE.rrc26.city, 'Dubai');
});

test('locateCollectors attaches sites; starArcs hubs the busiest collector', () => {
  const located = locateCollectors([
    { rrc: 'rrc00', peers: 5, avgPathLen: 3 },
    { rrc: 'rrc99', peers: 99, avgPathLen: 1 }, // unknown -> dropped
    { rrc: 'rrc01', peers: 2, avgPathLen: 4 },
  ]);
  assert.equal(located.length, 2);
  assert.equal(located[0].city, 'Amsterdam');
  const arcs = starArcs(located);
  assert.equal(arcs.length, 1);
  assert.equal(arcs[0].hub.rrc, 'rrc00');
  assert.equal(arcs[0].spoke.rrc, 'rrc01');
  assert.deepEqual(starArcs([{ rrc: 'rrc00' }]), []);
});

test('pulseSize grows with peers and stays clamped', () => {
  assert.ok(pulseSize(100) > pulseSize(1));
  assert.ok(pulseSize(0) >= 6 && pulseSize(1e9) <= 26);
});

test('createRipestatSource validates the /api/ripestat shape', async () => {
  const ok = createRipestatSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({ prefixes: [{ prefix: '1.1.1.0/24' }] }) }),
  });
  assert.deepEqual((await ok.getSnapshot()).prefixes.length, 1);
  const bad = createRipestatSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({ nope: 1 }) }),
  });
  await assert.rejects(() => bad.getSnapshot(), /ripestat_bad_shape/);
  const http = createRipestatSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(() => http.getSnapshot(), /ripestat_http_503/);
});
