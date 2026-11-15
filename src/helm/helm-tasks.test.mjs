/**
 * Helm task read-path tests (Incorporation Spec Candidate 2, step 3):
 * the Helm recites the Event Contract's woven tasks from the store —
 * five fields in plain words, citations to the store's own records,
 * verdict states exact, STALE evidence stated, an absent task
 * refused honestly, an empty store answered as the river's quiet.
 * Fixtures are endpoint-shaped payloads in the falsifiers' own task
 * shapes (weave scenarios A/C + the live store's evaluation shape).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { routeUtterance } from '../../public/helm-router.js';
import { createHelmTools } from '../../public/helm-tools.js';

const PLACE = {
  site: '03176500',
  name: 'NEW RIVER AT GLEN LYN, VA',
  lat: 37.3728986,
  lon: -80.8606347,
};
const RECORD_ID = 'usgs-water-glen-lyn-03176500@2026-11-15T09:15:00+00:00';
const AUTHORITY = {
  rule: 'Portals standing rule (PORTALS-PROPRIETARY-WEAVE-2026-11-14 §3.4): "when S6\'s gauge crosses 13 ft, birth a \'watch the river\' task at the gauge, owner: on-duty crew; at 15 ft, escalate stakes and wake the Helm"',
  birth:
    'an upward crossing of the caution threshold (13 ft at Glen Lyn) births this task',
  escalation:
    'an upward crossing of flood stage (15 ft at Glen Lyn) escalates the SAME task (stakes 5) and wakes the Helm (wakeHelm: true)',
};

function wovenTask(overrides = {}) {
  return {
    id: 'task-evt-000004',
    title:
      'Watch the river - New River at Glen Lyn (03176500) at/above caution 13 ft',
    place: PLACE,
    state: 'queued',
    owner: 'on-duty-crew',
    stakes: 3,
    bornFrom: 'evt-000004',
    evidence: [RECORD_ID, 'evt-000004'],
    honesty: `Measured (Provisional) - journal record ${RECORD_ID}`,
    ruleId: 'river-caution-birth',
    sourceId: 'usgs-water-glen-lyn-03176500',
    dependsOn: [RECORD_ID],
    escalated: false,
    wakeHelm: false,
    weave: 1,
    intent: 'watch the river',
    capability: 'river-watch',
    provider: 'on-duty-crew',
    authority: AUTHORITY,
    verdict: null,
    history: [
      {
        action: 'born',
        event: 'evt-000004',
        t: '2026-11-15T09:15:00+00:00',
        stage_ft: 13.0,
        band: 'CAUTION',
        stakes: 3,
      },
    ],
    ...overrides,
  };
}

const BORN_EVENT = {
  eventId: 'evt-000004',
  kind: 'task.born',
  t: '2026-11-15T09:15:00+00:00',
  sourceId: 'usgs-water-glen-lyn-03176500',
  place: PLACE,
  confidence: { class: 'Measured', qualifiers: ['Provisional'] },
  payload: { record_id: RECORD_ID, stage_ft: 13.0, band: 'CAUTION' },
};

// The live store's newest evaluation, verbatim shape (evt-000002).
const LAST_EVALUATION = {
  eventId: 'evt-000002',
  kind: 'evaluation',
  t: '2026-11-15T08:30:00+00:00',
  sourceId: 'usgs-water-glen-lyn-03176500',
  place: PLACE,
  confidence: { class: 'Measured', qualifiers: ['Provisional'] },
  payload: {
    action: 'none',
    band: 'NORMAL',
    stage_ft: 2.93,
    discharge_cfs: 1380.0,
    reason: 'no-crossing',
    record_id: 'usgs-water-glen-lyn-03176500@2026-11-15T08:30:00+00:00',
    stale: false,
  },
};

function storePayload(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-11-15T10:20:00.000Z',
    provider: 'helm-tasks',
    reachable: true,
    unavailable: false,
    count: 0,
    tasks: [],
    lifecycle: [],
    lastEvaluation: LAST_EVALUATION,
    evaluations: 2,
    parseIssues: 0,
    ...overrides,
  };
}

/** Emulates the bridge endpoint over one base payload. */
function storeFetch(base, calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    const u = new URL(String(url), 'http://helm.local');
    let body = base;
    const id = u.searchParams.get('id');
    if (id != null) {
      const task = (base.tasks || []).find((t) => t.id === id) || null;
      body = { ...base, query: { id }, found: task !== null, task };
    }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

function helmWith(base, calls) {
  return createHelmTools({
    fetchImpl: storeFetch(base, calls),
    loadSatellite: async () => {
      throw new Error('not needed');
    },
    now: () => Date.parse('2026-11-15T10:20:00Z'),
  });
}

describe('helm router — task read path', () => {
  it('"what\'s watching the river and why" routes to the tasks template', () => {
    const r = routeUtterance("What's watching the river and why?");
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.calls.map((c) => [c.tool, c.args.template]),
      [['world_ask', 'tasks']],
    );
  });
  it('task listing questions route to the tasks template', () => {
    for (const s of ['What tasks are open?', 'List tasks', 'Show me the tasks']) {
      const r = routeUtterance(s);
      assert.equal(r.ok, true, s);
      assert.equal(r.calls[0].tool, 'world_ask');
      assert.equal(r.calls[0].args.template, 'tasks');
    }
  });
  it('a full task id routes to per-task inspection', () => {
    const r = routeUtterance('Tell me about task task-evt-000004');
    assert.deepEqual(r.calls[0].args, {
      template: 'task',
      id: 'task-evt-000004',
    });
  });
  it('a bare event id after "task" normalizes to the task id', () => {
    const r = routeUtterance('Inspect task evt-000007');
    assert.deepEqual(r.calls[0].args, { template: 'task', id: 'task-evt-000007' });
  });
});

describe('helm tools — task store answers', () => {
  it('(a) one woven open task: the five fields recited, verdict open, birth cited', async () => {
    const task = wovenTask();
    const { tools } = helmWith(
      storePayload({ count: 1, tasks: [task], lifecycle: [BORN_EVENT] }),
    );
    const r = await tools.world_ask({ template: 'tasks' });
    assert.equal(r.ok, true);
    assert.match(r.summary, /1 task\(s\).*1 open, 0 closed/);
    assert.match(r.summary, /Intent: watch the river/);
    assert.match(r.summary, /Capability: river-watch/);
    assert.match(r.summary, /Provider: on-duty-crew/);
    assert.match(r.summary, /Authority: Portals standing rule/);
    assert.match(r.summary, /not yet written back — not yet worked/);
    assert.match(r.summary, /Born from event evt-000004/);
    assert.equal(r.citations.length, 1);
    assert.equal(r.citations[0].feed, 'event-contract-task-store');
    assert.equal(r.citations[0].dataTimestamp, '2026-11-15T09:15:00+00:00');
    assert.equal(r.citations[0].confidence, 'MEASURED');
    assert.ok(r.citations[0].note.includes(RECORD_ID));
  });

  it('(b) a closed task renders its written-back verdict, never "not yet worked"', async () => {
    const task = wovenTask({
      state: 'closed',
      stakes: 5,
      escalated: true,
      wakeHelm: true,
      verdict: {
        outcome: 'Stood down — the river fell below caution and held.',
        evidence: ['usgs-water-glen-lyn-03176500@2026-11-15T10:15:00+00:00'],
        closed_by: 'on-duty-crew',
        data_ts: '2026-11-15T10:15:00+00:00',
      },
    });
    const { tools } = helmWith(
      storePayload({ count: 1, tasks: [task], lifecycle: [BORN_EVENT] }),
    );
    const r = await tools.world_ask({
      template: 'task',
      id: 'task-evt-000004',
    });
    assert.equal(r.ok, true);
    assert.match(r.summary, /State: closed/);
    assert.match(r.summary, /Verdict written back: "Stood down/);
    assert.match(r.summary, /closed by on-duty-crew/);
    assert.match(r.summary, /evidence time 2026-11-15T10:15:00\+00:00/);
    assert.doesNotMatch(r.summary, /not yet worked/);
  });

  it('(c) an evidenceStale task states its STALE evidence in the sentence', async () => {
    const task = wovenTask({
      id: 'task-evt-000009',
      bornFrom: 'evt-000009',
      evidenceStale: true,
    });
    const { tools } = helmWith(
      storePayload({ count: 1, tasks: [task], lifecycle: [BORN_EVENT] }),
    );
    const r = await tools.world_ask({ template: 'tasks' });
    assert.equal(r.ok, true);
    assert.match(r.summary, /STALE evidence/);
    assert.match(r.summary, /evidenceStale label/);
  });

  it('(d) the empty store answers the river\'s quiet, citing the last evaluation', async () => {
    const { tools } = helmWith(storePayload());
    const r = await tools.world_ask({ template: 'tasks' });
    assert.equal(r.ok, true);
    assert.match(r.summary, /No tasks born yet — the river is quiet/);
    assert.match(r.summary, /2\.93 ft/);
    assert.match(r.summary, /band NORMAL/);
    assert.equal(r.citations[0].feed, 'event-contract-task-store');
    assert.equal(r.citations[0].dataTimestamp, '2026-11-15T08:30:00+00:00');
    assert.equal(r.citations[0].confidence, 'MEASURED');
  });

  it('a task that does not exist is refused honestly — no invented task', async () => {
    const { tools } = helmWith(
      storePayload({ count: 1, tasks: [wovenTask()], lifecycle: [BORN_EVENT] }),
    );
    const r = await tools.world_ask({
      template: 'task',
      id: 'task-evt-999999',
    });
    assert.equal(r.ok, false);
    assert.match(r.summary, /UNKNOWN/);
    assert.match(r.summary, /holds no task "task-evt-999999"/);
    assert.match(r.summary, /will not invent/);
    assert.match(r.summary, /task-evt-000004/);
  });

  it('an unreachable store is UNKNOWN, never a guessed empty store', async () => {
    const { tools } = helmWith({
      generatedAt: '2026-11-15T10:20:00.000Z',
      reachable: false,
      unavailable: true,
      reason: 'Task store files not readable on this host (Home Node).',
      count: 0,
      tasks: [],
      lifecycle: [],
      lastEvaluation: null,
      evaluations: 0,
    });
    const r = await tools.world_ask({ template: 'tasks' });
    assert.equal(r.ok, false);
    assert.match(r.summary, /UNKNOWN/);
    assert.match(r.summary, /Home Node/);
    assert.doesNotMatch(r.summary, /river is quiet/);
    assert.equal(r.citations[0].confidence, 'UNKNOWN');
  });

  it('READ-ONLY: every store fetch the Helm makes is a GET (no method override)', async () => {
    const calls = [];
    const { tools } = helmWith(
      storePayload({ count: 1, tasks: [wovenTask()], lifecycle: [BORN_EVENT] }),
      calls,
    );
    await tools.world_ask({ template: 'tasks' });
    await tools.world_ask({ template: 'task', id: 'task-evt-000004' });
    assert.ok(calls.length >= 2);
    for (const c of calls) {
      assert.ok(
        !c.init || !c.init.method || c.init.method === 'GET',
        `non-GET fetch: ${JSON.stringify(c.init)}`,
      );
      assert.ok(!c.init || !('body' in c.init), 'a fetch carried a body');
    }
  });
});
