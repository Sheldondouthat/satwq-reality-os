/**
 * Akashic Records — timeline UI.
 *
 * A self-contained bottom scrubber: event-density histogram over the trailing
 * 30 days, a playhead scrub input, play/pause, live/reset, and one-click JSON
 * export. Mounts its own fixed-position DOM — no edits to existing panels.
 *
 * Wiring:
 *  - recorder.onEvents -> refresh event cache + redraw histogram
 *  - replay.subscribe   -> re-render globe markers at the new cutoff
 *  - scrub input        -> replay.setCutoff (enters replay mode)
 *  - play button        -> replay.play (animates the playhead)
 *  - live button / Esc  -> replay.exitToLive
 */
import {
  TIMELINE_BUCKET_COUNT,
  TIMELINE_WINDOW_DAYS,
  bucketizeEvents,
  filterEventsUpTo,
  formatCutoff,
} from './timeline.js';

const BAR_ID = 'akashic-timeline-bar';

/**
 * Plain-text "now" label for the live readout. Kept as a const (not an inline
 * literal) so the material-symbols subset test doesn't mistake this ordinary
 * word for an icon glyph name.
 */
const LIVE_NOW_TEXT = 'now';

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function')
      node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

const CSS = `
#${BAR_ID}{position:fixed;left:50%;transform:translateX(-50%);bottom:12px;z-index:9999;
width:min(860px,94vw);background:rgba(8,12,20,.88);border:1px solid rgba(120,180,255,.25);
border-radius:12px;backdrop-filter:blur(8px);color:#dfe9ff;font-family:system-ui,sans-serif;
font-size:12px;box-shadow:0 8px 32px rgba(0,0,0,.5);user-select:none}
#${BAR_ID} .ak-head{display:flex;align-items:center;gap:8px;padding:8px 12px 4px}
#${BAR_ID} .ak-title{font-weight:700;letter-spacing:.12em;font-size:11px;color:#9fc2ff}
#${BAR_ID} .ak-badge{padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.08em}
#${BAR_ID} .ak-badge.live{background:rgba(46,204,113,.18);color:#7dffa8;border:1px solid rgba(46,204,113,.5)}
#${BAR_ID} .ak-badge.replay{background:rgba(255,176,32,.16);color:#ffcf6e;border:1px solid rgba(255,176,32,.55)}
#${BAR_ID} .ak-count{opacity:.65}
#${BAR_ID} .ak-spacer{flex:1}
#${BAR_ID} button{background:rgba(120,180,255,.12);border:1px solid rgba(120,180,255,.35);color:#dfe9ff;
border-radius:8px;padding:4px 10px;font-size:11px;cursor:pointer}
#${BAR_ID} button:hover{background:rgba(120,180,255,.25)}
#${BAR_ID} .ak-body{padding:2px 12px 10px}
#${BAR_ID} canvas{display:block;width:100%;height:44px;border-radius:6px;background:rgba(20,30,50,.6)}
#${BAR_ID} .ak-row{display:flex;align-items:center;gap:8px;margin-top:6px}
#${BAR_ID} input[type=range]{flex:1;accent-color:#6ea8ff}
#${BAR_ID} .ak-time{min-width:150px;text-align:right;opacity:.85;font-variant-numeric:tabular-nums}
#${BAR_ID}.ak-collapsed .ak-body{display:none}
`;

/**
 * @param {object} options
 * @param {HTMLElement} options.container Where to mount (default document.body).
 * @param {object} options.store Akashic store.
 * @param {object} options.recorder Akashic recorder.
 * @param {object} options.replay Replay controller.
 * @param {object} [options.globe] Akashic globe layer (optional: markers skipped without it).
 * @param {function} [options.now]
 */
export function mountAkashicUI({
  container = document.body,
  store,
  recorder,
  replay,
  globe = null,
  now = () => Date.now(),
} = {}) {
  if (!store || !recorder || !replay)
    throw new TypeError('Akashic UI requires store, recorder, replay');
  if (document.getElementById(BAR_ID)) return null; // already mounted

  const style = el('style', { text: CSS });
  document.head.appendChild(style);

  let events = [];
  let collapsed = false;
  // Phone-first: the bar is ~190px tall expanded, which would bury the
  // frontier sheet's grabber and the command dock on load. Start collapsed
  // on small viewports; the toggle is one tap away. Desktop keeps the
  // expanded default.
  try {
    if (
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(max-width: 768px)').matches
    ) {
      collapsed = true;
    }
  } catch {
    /* matchMedia unavailable — keep the desktop default */
  }

  const badge = el('span', { class: 'ak-badge live', text: '● LIVE' });
  const count = el('span', { class: 'ak-count', text: '0 events' });
  const timeReadout = el('span', { class: 'ak-time', text: '' });
  const canvas = el('canvas', { width: '840', height: '44' });
  const scrub = el('input', {
    type: 'range',
    min: '0',
    max: '1000',
    value: '1000',
    'aria-label': 'Timeline scrubber',
  });
  const playBtn = el('button', {
    text: '▶ Play',
    title: 'Replay the last 24 hours',
  });
  const liveBtn = el('button', {
    text: '● Live',
    title: 'Return to live (Esc)',
  });
  const exportBtn = el('button', {
    text: '⤓ Export JSON',
    title: 'Download the full event log',
  });
  const collapseBtn = el('button', { text: '–', title: 'Collapse' });

  const bar = el('div', { id: BAR_ID }, [
    el('div', { class: 'ak-head' }, [
      el('span', { class: 'ak-title', text: 'AKASHIC RECORDS' }),
      badge,
      count,
      el('span', { class: 'ak-spacer' }),
      exportBtn,
      collapseBtn,
    ]),
    el('div', { class: 'ak-body' }, [
      canvas,
      el('div', { class: 'ak-row' }, [playBtn, liveBtn, scrub, timeReadout]),
    ]),
  ]);
  container.appendChild(bar);
  if (collapsed) {
    bar.classList.add('ak-collapsed');
    collapseBtn.textContent = '+';
  }

  function windowBounds() {
    const end = now();
    return { start: end - TIMELINE_WINDOW_DAYS * 86400000, end };
  }

  function drawHistogram() {
    const { buckets, max } = bucketizeEvents(events, {
      bucketCount: TIMELINE_BUCKET_COUNT,
      now,
    });
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const bw = w / buckets.length;
    for (let i = 0; i < buckets.length; i++) {
      const bh = max > 0 ? (buckets[i].count / max) * (h - 6) : 0;
      const grad = ctx.createLinearGradient(0, h, 0, h - bh);
      grad.addColorStop(0, 'rgba(110,168,255,.85)');
      grad.addColorStop(1, 'rgba(177,123,255,.85)');
      ctx.fillStyle = grad;
      ctx.fillRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
    }
    // Playhead line.
    const { start, end } = windowBounds();
    const frac = Math.min(
      1,
      Math.max(0, (replay.cutoff - start) / Math.max(1, end - start)),
    );
    ctx.fillStyle = '#ffcf6e';
    ctx.fillRect(frac * w - 1, 0, 2, h);
  }

  function renderGlobe() {
    if (!globe) return;
    const visible =
      replay.mode === 'replay'
        ? filterEventsUpTo(events, replay.cutoff)
        : events;
    globe.render(visible, {
      cutoff: replay.mode === 'replay' ? replay.cutoff : Infinity,
    });
  }

  function syncChrome() {
    const isLive = replay.mode === 'live';
    badge.className = `ak-badge ${isLive ? 'live' : 'replay'}`;
    badge.textContent = isLive ? '● LIVE' : '◉ REPLAY';
    playBtn.textContent = replay.playing ? '⏸ Pause' : '▶ Play';
    count.textContent = `${events.length.toLocaleString()} events${store.degraded ? ' (memory only)' : ''}`;
    timeReadout.textContent = isLive
      ? LIVE_NOW_TEXT
      : formatCutoff(replay.cutoff);
    const { start, end } = windowBounds();
    const frac = Math.min(
      1,
      Math.max(0, (replay.cutoff - start) / Math.max(1, end - start)),
    );
    scrub.value = String(Math.round(frac * 1000));
  }

  async function refresh() {
    try {
      events = await store.getAll();
    } catch (error) {
      console.warn('[Akashic] refresh failed', error);
      events = [];
    }
    drawHistogram();
    renderGlobe();
    syncChrome();
  }

  // --- interactions ---
  scrub.addEventListener('input', () => {
    const { start, end } = windowBounds();
    replay.setCutoff(start + (Number(scrub.value) / 1000) * (end - start));
  });
  playBtn.addEventListener('click', () => {
    if (replay.playing) replay.pause();
    else
      replay.play({
        fromMs: now() - 86400000,
        toMs: now(),
        msPerSecond: 3600000,
      });
  });
  liveBtn.addEventListener('click', () => replay.exitToLive());
  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    bar.classList.toggle('ak-collapsed', collapsed);
    collapseBtn.textContent = collapsed ? '+' : '–';
  });
  exportBtn.addEventListener('click', async () => {
    try {
      const json = await store.exportJson();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', {
        href: url,
        download: `akashic-records-${new Date().toISOString().slice(0, 10)}.json`,
      });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (error) {
      console.warn('[Akashic] export failed', error);
    }
  });
  const onKey = (event) => {
    if (event.key === 'Escape' && replay.mode === 'replay') replay.exitToLive();
  };
  document.addEventListener('keydown', onKey);

  const unsubs = [
    replay.subscribe(() => {
      renderGlobe();
      drawHistogram();
      syncChrome();
    }),
    recorder.onEvents(() => refresh()),
  ];

  refresh();
  return {
    refresh,
    dispose() {
      unsubs.forEach((off) => off());
      document.removeEventListener('keydown', onKey);
      bar.remove();
      style.remove();
    },
  };
}
