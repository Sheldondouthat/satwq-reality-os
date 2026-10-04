/**
 * Watch scheduler (Wave 3, Track 1c, item 1.11).
 *
 * Cron-compatible design: watches carry a 5-field cron expression. The
 * in-process fallback ticks on setInterval; a runtime cron job can drive the
 * same watches by calling tick() — the schedule is data, not machinery.
 *
 * Storage is injected ({get,set}) so tests use memory and the browser uses
 * localStorage. Nothing here touches the network.
 */

export const WATCHES_KEY = 'satwq.watches.v1';

/**
 * Parse a 5-field cron expression. Supports `*`, `*\/n`, and single integers
 * in the minute and hour fields; day-of-month/month/day-of-week must be `*`.
 * Returns null when unsupported (a schedule the parser cannot honor is a
 * hard failure, never a silent mis-schedule).
 */
export function parseCron(expr) {
  const parts = String(expr ?? '')
    .trim()
    .split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  if (dom !== '*' || month !== '*' || dow !== '*') return null;
  const field = (token, max) => {
    if (token === '*') return { every: 1 };
    const m = token.match(/^\*\/(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      if (n < 1 || n > max) return null;
      return { every: n };
    }
    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n < 0 || n > max) return null;
      return { at: n };
    }
    return null;
  };
  const min = field(minute, 59);
  const hr = field(hour, 23);
  if (!min || !hr) return null;
  return { minute: min, hour: hr };
}

function matches(field, value) {
  if (field.every != null) return value % field.every === 0;
  return value === field.at;
}

/**
 * Next run strictly after fromMs (minute granularity). Returns null when no
 * run exists within a year (defensive; cannot happen for valid crons).
 */
export function nextRun(expr, fromMs) {
  const cron = parseCron(expr);
  if (!cron) return null;
  const limit = fromMs + 366 * 24 * 3600_000;
  let t = fromMs - (fromMs % 60000) + 60000;
  while (t <= limit) {
    const d = new Date(t);
    if (
      matches(cron.minute, d.getUTCMinutes()) &&
      matches(cron.hour, d.getUTCHours())
    )
      return t;
    t += 60000;
  }
  return null;
}

export function describeCron(expr) {
  const cron = parseCron(expr);
  if (!cron) return `invalid schedule "${expr}"`;
  const min =
    cron.minute.every != null
      ? `every ${cron.minute.every} min`
      : `at minute ${cron.minute.at}`;
  const hr =
    cron.hour.every != null
      ? `every ${cron.hour.every} h`
      : `at hour ${cron.hour.at} UTC`;
  return `${min}, ${hr}`;
}

function readAll(storage) {
  try {
    const raw = storage.get(WATCHES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAll(storage, watches) {
  storage.set(WATCHES_KEY, JSON.stringify(watches));
}

export function createScheduler({
  storage,
  evaluate,
  now = () => Date.now(),
  id = () => `w${Math.random().toString(36).slice(2, 10)}`,
} = {}) {
  if (
    !storage ||
    typeof storage.get !== 'function' ||
    typeof storage.set !== 'function'
  ) {
    throw new Error('scheduler needs a {get,set} storage');
  }

  function list() {
    return readAll(storage);
  }

  function add(watch) {
    const watches = readAll(storage);
    const entry = {
      id: id(),
      enabled: true,
      schedule: '*/15 * * * *',
      createdAt: now(),
      lastRun: null,
      lastFired: null,
      firings: [],
      ...watch,
    };
    if (!parseCron(entry.schedule))
      throw new Error(`unsupported schedule "${entry.schedule}"`);
    entry.nextDue = nextRun(entry.schedule, now());
    watches.push(entry);
    writeAll(storage, watches);
    return entry;
  }

  function remove(watchId) {
    writeAll(
      storage,
      readAll(storage).filter((w) => w.id !== watchId),
    );
  }

  function setEnabled(watchId, enabled) {
    const watches = readAll(storage);
    const w = watches.find((x) => x.id === watchId);
    if (w) {
      w.enabled = enabled;
      writeAll(storage, watches);
    }
  }

  /**
   * Evaluate every due, enabled watch. Returns the list of results.
   * Never throws — one bad watch cannot kill the tick.
   */
  async function tick(t = now()) {
    const watches = readAll(storage);
    const results = [];
    let dirty = false;
    for (const w of watches) {
      if (!w.enabled) continue;
      if (w.nextDue == null) w.nextDue = nextRun(w.schedule, t);
      if (w.nextDue == null || t < w.nextDue) continue;
      w.lastRun = t;
      dirty = true;
      try {
        const outcome = (await evaluate?.(w, t)) ?? {
          fired: false,
          detail: null,
        };
        if (outcome.fired) {
          w.lastFired = t;
          w.firings.push({ t, detail: outcome.detail ?? null });
          if (w.firings.length > 50) w.firings = w.firings.slice(-50);
        }
        results.push({
          watchId: w.id,
          ok: true,
          fired: outcome.fired,
          detail: outcome.detail ?? null,
        });
      } catch (error) {
        results.push({
          watchId: w.id,
          ok: false,
          fired: false,
          detail: error?.message ?? 'evaluate failed',
        });
      }
      w.nextDue = nextRun(w.schedule, t);
    }
    if (dirty) writeAll(storage, watches);
    return results;
  }

  let timer = null;
  function start(intervalMs = 60_000) {
    stop();
    timer = setInterval(() => {
      tick().catch(() => {});
    }, intervalMs);
    return () => stop();
  }
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { list, add, remove, setEnabled, tick, start, stop };
}
