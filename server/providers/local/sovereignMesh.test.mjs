/**
 * Sovereign Mesh (nodes) bridge tests: the bridge's feed_records.json,
 * served verbatim and read-only. The handler is exercised through the
 * captured middleware; the no-write / no-fetch law is asserted against
 * the module source itself (enforcement by absence — there is no
 * write or network code path to reach). The label law is the point of
 * the move: a replay product must reach the face labeled SYNTHETIC,
 * and an unreadable bridge file must degrade to the honest
 * unavailable envelope — never fabricated nodes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  sovereignMeshProxy,
  _sovereignMeshInternals,
} from './sovereignMesh.js';

const { parseFeed, buildUnavailable, defaultFeedFile, SOVEREIGN_MESH_ATTRIBUTION } =
  _sovereignMeshInternals;

const REPLAY = JSON.stringify({
  feed: 'Sovereign Mesh (nodes)',
  generated_at: '2026-11-15T03:44:33.654767+00:00',
  source: 'replay:sample_mqtt.jsonl',
  label: 'SYNTHETIC',
  confidence: 'Modeled',
  nodes: [
    {
      id: '!aa000001',
      label: 'SYNTHETIC',
      shortname: 'HOME',
      lat: 37.3186,
      lon: -80.6297,
      last_heard_age_s: 60,
    },
  ],
  links: [],
});

function captureHandler(proxy) {
  let mw;
  proxy.configureServer({
    middlewares: { use: (route, fn) => (mw = { route, fn }) },
  });
  return mw;
}

function mockRes() {
  const calls = [];
  return {
    calls,
    writeHead: (s, h) => calls.push(['head', s, h]),
    end: (body) => calls.push(['end', body]),
  };
}

const bodyOf = (res) => res.calls.find((c) => c[0] === 'end')?.[1];
const statusOf = (res) => res.calls.find((c) => c[0] === 'head')?.[1];

test('defaultFeedFile honors the env override, then the bridge path under HOME', () => {
  assert.equal(
    defaultFeedFile({ SOVEREIGN_MESH_FEED_FILE: '/x/feed.json', HOME: '/h' }),
    '/x/feed.json',
  );
  assert.equal(
    defaultFeedFile({ HOME: '/h' }),
    '/h/workspace/sky-map-quest/sovereign-mesh/bridge/feed_records.json',
  );
  assert.equal(defaultFeedFile({}), null);
});

test('parseFeed accepts the bridge contract shape and rejects anything else', () => {
  assert.equal(parseFeed(REPLAY)?.label, 'SYNTHETIC');
  assert.equal(parseFeed('{"nodes": []}')?.nodes.length, 0);
  assert.equal(parseFeed('{"links": []}'), null);
  assert.equal(parseFeed('not json'), null);
  assert.equal(parseFeed('null'), null);
});

test('handler serves the bridge bytes VERBATIM — labels untouched', async () => {
  const mw = captureHandler(
    sovereignMeshProxy({ readFeed: async () => REPLAY, feedFile: '/x' }),
  );
  assert.equal(mw.route, '/api/sovereign-mesh-nodes');
  const res = mockRes();
  await mw.fn({ method: 'GET', url: '/' }, res);
  assert.equal(statusOf(res), 200);
  // Byte-identical: no re-serialization, no label upgrade.
  assert.equal(bodyOf(res), REPLAY);
  const served = JSON.parse(bodyOf(res));
  assert.equal(served.label, 'SYNTHETIC');
  assert.equal(served.source, 'replay:sample_mqtt.jsonl');
});

test('handler degrades to the honest unavailable envelope when the file is unreadable', async () => {
  const mw = captureHandler(
    sovereignMeshProxy({ readFeed: async () => null, feedFile: '/x' }),
  );
  const res = mockRes();
  await mw.fn({ method: 'GET', url: '/' }, res);
  assert.equal(statusOf(res), 200);
  const payload = JSON.parse(bodyOf(res));
  assert.equal(payload.unavailable, true);
  assert.equal(payload.label, 'UNAVAILABLE');
  assert.deepEqual(payload.nodes, []);
  assert.deepEqual(payload.links, []);
  assert.match(payload.reason, /not readable on this host/);
  assert.equal(payload.attribution, SOVEREIGN_MESH_ATTRIBUTION);
});

test('handler degrades (does not serve) when the file is malformed', async () => {
  const mw = captureHandler(
    sovereignMeshProxy({ readFeed: async () => '{"feed": 1}', feedFile: '/x' }),
  );
  const res = mockRes();
  await mw.fn({ method: 'GET', url: '/' }, res);
  assert.equal(JSON.parse(bodyOf(res)).unavailable, true);
});

test('handler refuses non-GET with 405', async () => {
  const mw = captureHandler(
    sovereignMeshProxy({ readFeed: async () => REPLAY, feedFile: '/x' }),
  );
  const res = mockRes();
  await mw.fn({ method: 'POST', url: '/' }, res);
  assert.equal(statusOf(res), 405);
});

test('buildUnavailable never fabricates a node and carries the attribution verbatim', () => {
  const env = buildUnavailable('x');
  assert.equal(env.nodes.length, 0);
  assert.equal(
    env.attribution,
    "Sovereign Mesh — the operator's own LoRa mesh network (Part 15, 902-928 MHz). Node positions and telemetry reported by the operator's own nodes; served locally, not redistributed.",
  );
});

test('module source has no write or network code path (enforcement by absence)', () => {
  const src = readFileSync(new URL('./sovereignMesh.js', import.meta.url), 'utf8');
  for (const banned of [
    'writeFile',
    'appendFile',
    'createWriteStream',
    'fetch(',
    'http.request',
    'https.request',
    'mqtt',
    'WebSocket',
  ]) {
    assert.ok(!src.includes(banned), `sovereignMesh.js must not contain ${banned}`);
  }
  assert.ok(src.includes('readFile'), 'the one permitted verb is readFile');
});
