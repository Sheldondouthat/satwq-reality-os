/**
 * Akashic Records — scrubbable history timeline UX.
 *
 * "March 14: replay the day." A floating panel listing archived days; picking
 * a day shows its events in chronological order with a replay button that
 * flies the Cesium camera through each event. When a GIBS DVR layer is passed
 * (compose seam), a "view in DVR" button hands the day to dvr.setTime(day).
 *
 * All DOM is inline-styled; no stylesheet edits needed. Mount is fail-soft.
 */
import { dayKey, daySummary, shiftDay } from './schema.js';

const KIND_LABEL = {
  quake: '🌋 quake',
  alert: '⚠️ alert',
  incident: '◈ incident',
  fireball: '☄️ fireball',
  launch: '🚀 launch',
  storm: '🌀 storm',
};

const SEV_COLOR = {
  critical: '#ff5a5a',
  high: '#ffb347',
  moderate: '#9fc2ff',
};

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Sort archived days and pick the index nearest `day`. Pure helper (tested). */
export function nearestDayIndex(days, day) {
  if (!days.length) return -1;
  if (!day) return days.length - 1;
  let best = 0;
  let bestDist = Infinity;
  const target = Date.parse(`${day}T00:00:00Z`);
  for (let i = 0; i < days.length; i += 1) {
    const ms = Date.parse(`${days[i]}T00:00:00Z`);
    if (!Number.isFinite(ms)) continue;
    const dist = Math.abs(ms - target);
    // Ties break toward the later day (timeline defaults to "today-forward").
    if (
      dist < bestDist ||
      (dist === bestDist && ms > Date.parse(`${days[best]}T00:00:00Z`))
    ) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * Build the timeline panel.
 *
 * @param {object} opts
 * @param {object} opts.store — akashic store
 * @param {object} [opts.viewer] — Cesium viewer (for replay fly-to)
 * @param {object} [opts.dvr] — GIBS DVR layer with setTime(day)
 */
export function createAkashicTimeline({
  store,
  viewer = null,
  dvr = null,
} = {}) {
  if (typeof document === 'undefined') return null;

  const panel = el(
    'div',
    'position:fixed;right:12px;top:12px;z-index:9991;width:320px;max-height:70vh;' +
      'overflow:auto;background:rgba(8,12,20,.92);border:1px solid rgba(120,180,255,.25);' +
      'border-radius:10px;color:#dfe9ff;font:12px/1.45 system-ui,sans-serif;' +
      'padding:10px 12px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:none;',
  );
  panel.setAttribute('aria-label', 'Akashic records timeline');

  const title = el(
    'div',
    'font-weight:700;letter-spacing:.08em;font-size:11px;color:#9fc2ff;margin-bottom:6px;',
    '◈ AKASHIC RECORDS — replay the day',
  );
  panel.appendChild(title);

  const dayRow = el(
    'div',
    'display:flex;gap:6px;align-items:center;margin-bottom:8px;',
  );
  const prevBtn = el('button', chipStyle(), '◀');
  const dayLabel = el('div', 'flex:1;text-align:center;font-weight:600;', '—');
  const nextBtn = el('button', chipStyle(), '▶');
  dayRow.append(prevBtn, dayLabel, nextBtn);
  panel.appendChild(dayRow);

  const list = el('div', '');
  panel.appendChild(list);

  const foot = el('div', 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;');
  const replayBtn = el('button', chipStyle(), '▶ replay the day');
  const dvrBtn = el('button', chipStyle(), 'view in GIBS DVR');
  const closeBtn = el('button', chipStyle(), 'close');
  foot.append(replayBtn, dvrBtn, closeBtn);
  panel.appendChild(foot);

  let dayIndex = -1;
  let replaying = false;

  function refresh() {
    const days = store.days();
    dayIndex = nearestDayIndex(
      days,
      dayIndex >= 0 && days[dayIndex] ? days[dayIndex] : dayKey(Date.now()),
    );
    if (dayIndex < 0) {
      dayLabel.textContent = 'no archived days yet';
      list.textContent =
        'The archiver saves significant events (M5.5+ quakes, warnings, fireballs, launches, major storms) as they happen.';
      replayBtn.disabled = true;
      dvrBtn.disabled = true;
      return;
    }
    const day = days[dayIndex];
    const events = store.eventsForDay(day);
    dayLabel.textContent = daySummary(day, events.length);
    list.innerHTML = '';
    for (const rec of events) {
      const item = el(
        'div',
        'border-left:3px solid ' +
          (SEV_COLOR[rec.severity] || '#9fc2ff') +
          ';padding:4px 8px;margin:4px 0;background:rgba(30,45,70,.4);border-radius:0 6px 6px 0;cursor:pointer;',
      );
      const head = el(
        'div',
        'font-size:11px;',
        `${KIND_LABEL[rec.kind] || rec.kind} · ${new Date(rec.atMs).toUTCString().slice(17, 22)} UTC`,
      );
      const t = el('div', 'font-weight:600;', rec.title);
      const d = el('div', 'color:#9db4d8;font-size:11px;', rec.detail);
      item.append(head, t, d);
      item.addEventListener('click', () => flyToRecord(rec));
      list.appendChild(item);
    }
    replayBtn.disabled = events.length === 0;
    dvrBtn.disabled = !dvr || typeof dvr.setTime !== 'function';
  }

  function step(delta) {
    const days = store.days();
    if (!days.length) return;
    dayIndex = Math.min(
      days.length - 1,
      Math.max(0, (dayIndex < 0 ? days.length - 1 : dayIndex) + delta),
    );
    refresh();
  }

  async function flyToRecord(rec) {
    if (!viewer || !Number.isFinite(rec.lat) || !Number.isFinite(rec.lon))
      return;
    try {
      const { Cartesian3, Math: CMath } = await import('cesium');
      viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(rec.lon, rec.lat, 1200000),
        orientation: { heading: 0, pitch: CMath.toRadians(-55), roll: 0 },
        duration: 2.5,
      });
    } catch {
      /* fail-soft */
    }
  }

  async function replayDay() {
    if (replaying) return;
    const days = store.days();
    const day = days[dayIndex];
    if (!day) return;
    const events = store
      .eventsForDay(day)
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    if (!events.length) return;
    replaying = true;
    replayBtn.textContent = '⏸ replaying…';
    try {
      for (const rec of events) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 2600));
        // eslint-disable-next-line no-await-in-loop
        await flyToRecord(rec);
      }
    } finally {
      replaying = false;
      replayBtn.textContent = '▶ replay the day';
    }
  }

  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  replayBtn.addEventListener('click', replayDay);
  dvrBtn.addEventListener('click', () => {
    const days = store.days();
    const day = days[dayIndex];
    if (day && dvr && typeof dvr.setTime === 'function') {
      try {
        dvr.setTime(day);
      } catch {
        /* fail-soft */
      }
    }
  });
  closeBtn.addEventListener('click', () => {
    panel.style.display = 'none';
  });

  document.body.appendChild(panel);
  refresh();

  return {
    element: panel,
    open: () => {
      panel.style.display = 'block';
      refresh();
    },
    close: () => {
      panel.style.display = 'none';
    },
    refresh,
    destroy: () => panel.remove(),
    _nearestDayIndex: nearestDayIndex, // exposed for tests via module export too
  };
}

function chipStyle() {
  return (
    'padding:5px 9px;border-radius:20px;border:1px solid rgba(120,180,255,.35);' +
    'background:rgba(30,45,70,.6);color:#dfe9ff;cursor:pointer;font-size:11px;'
  );
}

export { shiftDay };
