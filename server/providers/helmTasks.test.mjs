/**
 * Helm task read-path bridge tests: the Event Contract's store,
 * served verbatim and read-only. Payload building is pure; the
 * handler is exercised through the captured middleware; the
 * no-write law is asserted against the module source itself
 * (enforcement by absence — there is no write code path to reach).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  helmTasksProxy,
  _helmTasksInternals,
} from './helmTasks.js';

const { parseStore, buildPayload, defaultStoreDir, LIFECYCLE_KINDS } =
  _helmTasksInternals;

const T0 = Date.parse('2026-11-15T10:20:00Z');

const TASK = {
  id: 'task-evt-000004',
  title:
    'Watch the river - New River at Glen Lyn (03176500) at/above caution 13 ft',
  state: 'queued',
  bornFrom: 'evt-000004',
  verdict: null,
};

const EVENTS = [
  {
    eventId: 'evt-000001',
    kind: 'evaluation',
    t: '2026-11-15T07:30:00+00:00',
    payload: { action: 'none', band: 'NORMAL', stage_ft: 2.94 },
  },
  {
    eventId: 'evt-000004',
    kind: 'task.born',
    t: '2026-11-15T09:15:00+00:00',
    payload: { task_id: 'task-evt-000004' },
  },
  {
    eventId: 'evt-000009',
    kind: 'task.verdict',
    t: '2026-11-15T10:15:00+00:00',
    payload: { task_id: 'task-evt-000004' },
  },
];

const store = () => ({
  tasks: [TASK],
  events: EVENTS,
  parseIssues: 0,
});

test('parseStore reads tasks.json + events.jsonl; a torn line is counted, not fatal', () => {
  const parsed = parseStore(
    JSON.stringify({ tasks: [TASK] }),
    EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n{"torn"',
  );
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.parseIssues, 1);
});

test('buildPayload: listing carries tasks verbatim, lifecycle filtered, last evaluation newest', () => {
  const p = buildPayload(store(), { now: () => T0 });
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.provider, 'helm-tasks');
  assert.equal(p.reachable, true);
  assert.equal(p.unavailable, false);
  assert.equal(p.count, 1);
  assert.deepEqual(p.tasks, [TASK]);
  assert.deepEqual(
    p.lifecycle.map((e) => e.kind),
    ['task.born', 'task.verdict'],
  );
  assert.ok(LIFECYCLE_KINDS.includes('birth-refused'));
  assert.equal(p.evaluations, 1);
  assert.equal(p.lastEvaluation.eventId, 'evt-000001');
});

test('buildPayload: ?id= resolves found and not-found as facts, both 200-shaped', () => {
  const hit = buildPayload(store(), { now: () => T0, taskId: TASK.id });
  assert.equal(hit.found, true);
  assert.equal(hit.task.id, TASK.id);
  const miss = buildPayload(store(), {
    now: () => T0,
    taskId: 'task-evt-999999',
  });
  assert.equal(miss.found, false);
  assert.equal(miss.task, null);
  assert.equal(miss.count, 1);
});

test('buildPayload: no store -> honest unavailable, never a fabricated empty store', () => {
  const p = buildPayload(null, { now: () => T0 });
  assert.equal(p.unavailable, true);
  assert.equal(p.reachable, false);
  assert.equal(p.count, 0);
  assert.deepEqual(p.tasks, []);
  assert.match(p.reason, /Home Node/);
});

test('defaultStoreDir: env override wins, HOME default, neither -> null', () => {
  assert.equal(
    defaultStoreDir({ HELM_TASK_STORE_DIR: '/x/y', HOME: '/home/z' }),
    '/x/y',
  );
  assert.equal(
    defaultStoreDir({ HOME: '/home/z' }),
    '/home/z/workspace/sky-map-quest/home-node/events',
  );
  assert.equal(defaultStoreDir({}), null);
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

test('handler: GET serves the payload at /api/helm-tasks; POST is 405', async () => {
  const proxy = helmTasksProxy({
    readStore: async () => store(),
    now: () => T0,
  });
  const mw = captureHandler(proxy);
  assert.equal(mw.route, '/api/helm-tasks');
  const res = mockRes();
  await mw.fn({ method: 'GET', url: '/' }, res);
  assert.equal(res.calls[0][1], 200);
  const body = JSON.parse(res.calls[1][1]);
  assert.equal(body.count, 1);
  const res2 = mockRes();
  await mw.fn({ method: 'POST', url: '/' }, res2);
  assert.equal(res2.calls[0][1], 405);
});

test('handler: ?id= flows through to found/task', async () => {
  const proxy = helmTasksProxy({
    readStore: async () => store(),
    now: () => T0,
  });
  const mw = captureHandler(proxy);
  const res = mockRes();
  await mw.fn({ method: 'GET', url: `/?id=${TASK.id}` }, res);
  const body = JSON.parse(res.calls[1][1]);
  assert.equal(body.found, true);
  assert.equal(body.task.id, TASK.id);
});

test('handler: unreadable store degrades to unavailable, still 200 JSON', async () => {
  const proxy = helmTasksProxy({
    readStore: async () => null,
    now: () => T0,
  });
  const mw = captureHandler(proxy);
  const res = mockRes();
  await mw.fn({ method: 'GET', url: '/' }, res);
  assert.equal(res.calls[0][1], 200);
  assert.equal(JSON.parse(res.calls[1][1]).unavailable, true);
});

test('NO-WRITE LAW: the module source holds no filesystem write verb, and no export can write', () => {
  const src = readFileSync(new URL('./helmTasks.js', import.meta.url), 'utf8');
  for (const token of [
    'writeFile',
    'appendFile',
    'createWriteStream',
    'mkdir',
    'rename(',
    'unlink',
    'rmdir',
    'copyFile',
    'truncate',
    'fsync',
  ]) {
    assert.ok(!src.includes(token), `forbidden write token present: ${token}`);
  }
  assert.ok(src.includes('readFile'), 'the one read verb is present');
  assert.deepEqual(Object.keys(_helmTasksInternals).sort(), [
    'LIFECYCLE_KINDS',
    'buildPayload',
    'defaultStoreDir',
    'parseStore',
  ]);
});
