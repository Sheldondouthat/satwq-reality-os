/**
 * Watch queries + Akashic replay — frontend (Wave 3, Track 1c, item 1.11).
 *
 * Fail-soft mount: watch list panel (scheduled NL watches evaluated on the
 * in-process scheduler, cron-compatible so a runtime cron can drive the same
 * watches) + one-click cinematic replay of any archived day from the
 * day-keyed event log (GIBS time-scrub + event steps + sonification).
 *
 * Public surface:
 *   initWatchReplay({ viewer, mount, fetchImpl, geocode, sonify, dvr }) -> { destroy }
 */
import {
  parseWatchQuery,
  resolveWatchCenter,
  evaluateWatch,
} from './watches.js';
import { createScheduler, describeCron } from './scheduler.js';
import {
  appendEvents,
  readDay,
  listDayKeys,
  quakeRowsToEvents,
  pruneDays,
  dayKey,
} from './eventLog.js';
import { createReplay } from './replay.js';
import { geocodeKeyless } from '../../../keylessGeocoder.js';

const USGS_FEED =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const WATER_TWIN_API = '/api/water-twin';
const SAMPLE_MS = 60 * 60_000; // sample the quake feed into the day log hourly

/**
 * Scheduler tick evaluator (exported for tests).
 *
 * The scheduler hands us the stored ENTRY ({id, schedule, condition, ...});
 * the parsed condition lives under entry.condition. Evaluating the entry
 * itself was a silent total failure: entry.kind is undefined, so
 * resolveWatchCenter returned it unchanged and evaluateWatch fell through
 * to kind:'custom' — every scheduled watch degraded to "review manually"
 * and never fired. Regression test below pins entry.condition.
 */
export async function evaluateWatchEntry(entry, { geocode, fetchLiveData }) {
  const condition = entry?.condition ?? entry;
  const resolved = await resolveWatchCenter(condition, { geocode }).catch(
    () => null,
  );
  if (!resolved) return { fired: false, detail: 'place could not be geocoded' };
  return evaluateWatch(resolved, await fetchLiveData());
}

function memStorage() {
  const map = new Map();
  return {
    get: (k) => (map.has(k) ? map.get(k) : null),
    set: (k, v) => {
      map.set(k, v);
    },
    remove: (k) => {
      map.delete(k);
    },
    keys: () => [...map.keys()],
  };
}

function browserStorage() {
  try {
    const ls = window.localStorage;
    return {
      get: (k) => ls.getItem(k),
      set: (k, v) => ls.setItem(k, v),
      remove: (k) => ls.removeItem(k),
      keys: () => Object.keys(ls),
    };
  } catch {
    return memStorage();
  }
}

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (text) node.textContent = text;
  return node;
}

export function initWatchReplay({
  viewer = null,
  mount = null,
  fetchImpl = fetch,
  geocode = geocodeKeyless,
  sonify = null,
  dvr = null,
} = {}) {
  const storage = browserStorage();
  const root = el('div', {});
  if (mount) mount(root);

  async function fetchLiveData() {
    const data = { quakes: [], rivers: [] };
    try {
      const res = await fetchImpl(USGS_FEED);
      if (res.ok) {
        const payload = await res.json();
        data.quakes = (payload.features ?? [])
          .map((f) => ({
            mag: Number(f?.properties?.mag),
            lat: Number(f?.geometry?.coordinates?.[1]),
            lon: Number(f?.geometry?.coordinates?.[0]),
            place: f?.properties?.place,
            timeMs: Number(f?.properties?.time),
          }))
          .filter((q) => Number.isFinite(q.mag) && Number.isFinite(q.lat));
      }
    } catch {}
    try {
      const res = await fetchImpl(WATER_TWIN_API);
      if (res.ok) {
        const payload = await res.json();
        data.rivers = payload.rivers ?? [];
      }
    } catch {}
    return data;
  }

  const scheduler = createScheduler({
    storage,
    evaluate: (entry) => evaluateWatchEntry(entry, { geocode, fetchLiveData }),
  });

  const replay = createReplay({ viewer, sonify, dvr });

  // — Day-log sampler: hourly sweep of the quake feed into today's log. —
  let sampleTimer = null;
  let stopped = false;
  async function sampleOnce() {
    try {
      const { quakes } = await fetchLiveData();
      if (quakes.length && !stopped) {
        appendEvents(storage, new Date(), quakeRowsToEvents(quakes));
        pruneDays(storage, 30);
      }
    } catch {}
  }
  sampleOnce();
  sampleTimer = setInterval(sampleOnce, SAMPLE_MS);

  // — Panel UI. —
  const status = el('div', { style: 'font-size:10px;color:#7d8fb3;' }, '');
  const input = el('input', {
    type: 'text',
    placeholder: 'e.g. alert me when M7+ within 500 km of Tokyo',
    'aria-label': 'New watch query',
    style:
      'width:100%;box-sizing:border-box;padding:6px 9px;border-radius:7px;border:1px solid rgba(120,180,255,.35);background:rgba(10,18,32,.9);color:#dfe9ff;font-size:11px;',
  });
  const list = el('div', {});
  root.append(input, list, status);

  function say(text) {
    status.textContent = text;
  }

  async function refreshList() {
    list.textContent = '';
    for (const w of scheduler.list()) {
      const row = el('div', {
        style:
          'margin:5px 0;font-size:11px;display:flex;gap:6px;align-items:center;',
      });
      row.appendChild(
        el(
          'span',
          { style: 'flex:1;' },
          `${w.condition?.raw ?? w.raw ?? '?'} · ${describeCron(w.schedule)}${w.lastFired ? ` · last fired ${new Date(w.lastFired).toLocaleString()}` : ''}`,
        ),
      );
      const del = el(
        'button',
        {
          style:
            'cursor:pointer;background:none;border:1px solid rgba(120,180,255,.35);color:#dfe9ff;border-radius:6px;font-size:10px;padding:2px 7px;',
        },
        '✕',
      );
      del.addEventListener('click', () => {
        scheduler.remove(w.id);
        refreshList();
      });
      row.appendChild(del);
      list.appendChild(row);
    }
    if (!scheduler.list().length)
      list.appendChild(
        el(
          'div',
          { style: 'font-size:11px;color:#7d8fb3;' },
          'No watches yet.',
        ),
      );
  }

  input.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || !input.value.trim()) return;
    const text = input.value.trim();
    input.value = '';
    try {
      const condition = parseWatchQuery(text, { riverRegistry: [] });
      const resolved = await resolveWatchCenter(condition, { geocode });
      if (!resolved) {
        say(`Couldn't geocode "${condition.placeQuery ?? text}".`);
        return;
      }
      scheduler.add({ raw: text, condition: resolved });
      say(`Watching: ${text}`);
      refreshList();
    } catch (error) {
      say(`Couldn't add watch: ${error?.message}`);
    }
  });

  const runNow = el(
    'button',
    {
      style:
        'margin-top:6px;cursor:pointer;background:rgba(30,45,70,.6);border:1px solid rgba(120,180,255,.35);color:#dfe9ff;border-radius:7px;font-size:11px;padding:5px 10px;',
    },
    '▶ Run watches now',
  );
  runNow.addEventListener('click', async () => {
    say('Evaluating watches…');
    const results = await scheduler.tick(Date.now());
    const fired = results.filter((r) => r.fired);
    say(
      fired.length
        ? `🔔 ${fired.map((r) => r.detail).join(' | ')}`
        : 'No watches fired.',
    );
    refreshList();
  });
  root.appendChild(runNow);

  const replayBtn = el(
    'button',
    {
      style:
        'margin:6px 0 0 6px;cursor:pointer;background:rgba(30,45,70,.6);border:1px solid rgba(120,180,255,.35);color:#dfe9ff;border-radius:7px;font-size:11px;padding:5px 10px;',
    },
    '🎬 Replay yesterday',
  );
  replayBtn.addEventListener('click', async () => {
    const y = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
    const events = readDay(storage, y);
    if (!events.length) {
      say(`No archived events for ${y} yet — the day log fills hourly.`);
      return;
    }
    say(`Replaying ${events.length} events from ${y}…`);
    const ctl = replay.playDay({
      day: y,
      events,
      speed: 2,
      onStep: (e, i, n) => say(`[${i + 1}/${n}] ${e.label}`),
    });
    ctl.done.then((r) => {
      if (!stopped) say(`Replay finished — ${r.played} events.`);
    });
  });
  root.appendChild(replayBtn);

  refreshList();
  const stopScheduler = scheduler.start(60_000);

  return {
    destroy() {
      stopped = true;
      stopScheduler();
      replay.stop();
      if (sampleTimer) clearInterval(sampleTimer);
      root.remove();
    },
    // Test seams (not for the dock).
    _scheduler: scheduler,
    _storage: storage,
    _replay: replay,
  };
}

/** Exported for the day-keyed log contract docs/tests. */
export { dayKey, listDayKeys };
