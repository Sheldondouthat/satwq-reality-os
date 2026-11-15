/**
 * Helm task read path — the Event Contract's task store, READ-ONLY.
 *
 * The Event Contract (sky-map-quest/home-node/events/event_contract.py)
 * births woven tasks into a file store on the Home Node stand-in host:
 *   tasks.json   — { tasks: [ <§3.2 task records with the TaskWeaver weave> ] }
 *   events.jsonl — the §3.4 event log (evaluations + task lifecycle)
 * The store lives OUTSIDE this repo, beside the Journal Seed. This
 * provider is the bridge the Helm's task answers read through: a
 * GET-only endpoint that serves the store's own records verbatim —
 * tasks as stored, the task-lifecycle events (task.born /
 * task.escalated / task.verdict / birth-refused), and the newest
 * evaluation event (the citation for "the river is quiet").
 *
 * READ-ONLY BY CONSTRUCTION (enforcement by absence): this module
 * contains no write code path at all — the only filesystem verb it
 * can perform is readFile, opened read-only. There is no verb here
 * that closes, escalates, or modifies a task; the store's write-back
 * verb belongs to the Event Contract's own CLI, never to this bridge
 * and never to the Helm. helmTasks.test.mjs asserts the absence from
 * the module source itself.
 *
 * CONFIG: the store directory comes from HELM_TASK_STORE_DIR
 * (absolute). Default: $HOME/workspace/sky-map-quest/home-node/events
 * — the Home Node stand-in's known path. On any host where the files
 * are not readable (e.g. the Cloudflare edge, which has no access to
 * the node's disk), the endpoint answers the honest phoneSensors-
 * class payload { unavailable: true } — never a fabricated empty
 * store. An empty store and an unreachable store are different facts
 * and are never conflated.
 *
 * SHAPE:
 *   GET /api/helm-tasks           → { schemaVersion, generatedAt,
 *     provider, reachable, count, tasks[], lifecycle[],
 *     lastEvaluation, evaluations }
 *   GET /api/helm-tasks?id=<id>   → same, plus { query:{id}, found,
 *     task } (found:false is a 200 — the Helm renders the honest
 *     refusal from it; an absent id is a fact about the store, not
 *     a transport error).
 */

const LIFECYCLE_KINDS = Object.freeze([
  'task.born',
  'task.escalated',
  'task.verdict',
  'birth-refused',
]);

/**
 * Store directory from config. Pure string work (no node:os /
 * node:path imports) so the module graph stays workerd-safe; the
 * filesystem itself is only touched lazily inside defaultReadStore.
 */
export function defaultStoreDir(env = process.env) {
  if (env && env.HELM_TASK_STORE_DIR) return env.HELM_TASK_STORE_DIR;
  if (env && env.HOME)
    return `${env.HOME}/workspace/sky-map-quest/home-node/events`;
  return null;
}

/**
 * Parse the store's two files into { tasks, events, parseIssues }.
 * Pure — exported for tests. A torn JSONL line is skipped and
 * counted, never silently swallowed and never fatal.
 */
export function parseStore(tasksRaw, eventsRaw) {
  let tasks = [];
  try {
    const doc = JSON.parse(tasksRaw);
    if (doc && Array.isArray(doc.tasks)) tasks = doc.tasks;
  } catch {
    tasks = [];
  }
  const events = [];
  let parseIssues = 0;
  for (const line of String(eventsRaw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      parseIssues += 1;
    }
  }
  return { tasks, events, parseIssues };
}

/** Build the endpoint payload from a parsed store (or null). Pure. */
export function buildPayload(store, { now = () => Date.now(), taskId = null } = {}) {
  const base = {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    provider: 'helm-tasks',
  };
  if (!store) {
    return {
      ...base,
      reachable: false,
      unavailable: true,
      reason:
        'Task store files not readable on this host (the store lives on the ' +
        'Home Node; HELM_TASK_STORE_DIR unset or files absent). No store ' +
        'state is claimed.',
      count: 0,
      tasks: [],
      lifecycle: [],
      lastEvaluation: null,
      evaluations: 0,
    };
  }
  const tasks = Array.isArray(store.tasks) ? store.tasks : [];
  const events = Array.isArray(store.events) ? store.events : [];
  const lifecycle = events.filter((e) => LIFECYCLE_KINDS.includes(e.kind));
  const evaluations = events.filter((e) => e.kind === 'evaluation');
  const payload = {
    ...base,
    reachable: true,
    unavailable: false,
    count: tasks.length,
    tasks,
    lifecycle,
    lastEvaluation: evaluations.length
      ? evaluations[evaluations.length - 1]
      : null,
    evaluations: evaluations.length,
    parseIssues: store.parseIssues || 0,
  };
  if (taskId != null) {
    const task = tasks.find((t) => t && t.id === taskId) || null;
    payload.query = { id: taskId };
    payload.found = task !== null;
    payload.task = task;
  }
  return payload;
}

/**
 * Default store reader: the node's files, read-only. node:fs is
 * imported lazily so the module graph stays workerd-safe (the
 * phoneSensors pattern) — on the edge the read simply fails and the
 * payload degrades to unavailable, honestly.
 */
async function defaultReadStore(storeDir) {
  if (!storeDir) return null;
  try {
    const fs = await import('node:fs/promises');
    const [tasksRaw, eventsRaw] = await Promise.all([
      fs.readFile(`${storeDir}/tasks.json`, 'utf8'),
      fs.readFile(`${storeDir}/events.jsonl`, 'utf8'),
    ]);
    return parseStore(tasksRaw, eventsRaw);
  } catch {
    return null;
  }
}

export function helmTasksProxy({
  readStore = defaultReadStore,
  storeDir = defaultStoreDir(),
  now = () => Date.now(),
} = {}) {
  async function handler(req, res) {
    const json = (status, value) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' });
      let taskId = null;
      try {
        const url = new URL(req.url || '/', 'http://helm-tasks.local');
        taskId = url.searchParams.get('id');
      } catch {
        taskId = null;
      }
      const store = await readStore(storeDir).catch(() => null);
      json(200, buildPayload(store, { now, taskId }));
    } catch {
      json(500, { error: 'internal server error' });
    }
  }

  return {
    name: 'helm-tasks',
    configureServer({ middlewares }) {
      middlewares.use('/api/helm-tasks', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/helm-tasks', handler);
    },
  };
}

export const _helmTasksInternals = {
  parseStore,
  buildPayload,
  defaultStoreDir,
  LIFECYCLE_KINDS,
};
