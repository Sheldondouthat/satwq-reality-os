/**
 * F2 — Planetary DVR layer + scrubber controls.
 *
 * `createDvrLayer` wraps the shared imagery-tile factory with a
 * date-controllable source: calling `setTime('YYYY-MM-DD')` probes the date
 * and, when tiles exist, swaps the WMTS TIME dimension (the provider is
 * rebuilt by the factory on template change). A date with no tiles keeps
 * the last good frame and is recorded in `unavailableDates()`.
 *
 * `createDvrControls(layer)` builds the self-contained scrubber DOM
 * (range slider + play/pause + date readout + live-reset), styled inline so
 * no stylesheet edits are needed.
 */
import { createImageryTileLayer } from '../imageryTile/factory.js';
import { GIBS_PRODUCTS } from '../imageryTile/products.js';
import { createDvrSource } from './source.js';
import {
  DVR_DEFAULT_DAYS,
  dvrDateRange,
  clampGibsDate,
  dateToIndex,
  indexToDate,
  isValidGibsDate,
} from './model.js';

const SIX_HOURS_MS = 6 * 3600 * 1000;
const PLAY_TICK_MS = 900;

export function createDvrLayer({ source, updateInterval = SIX_HOURS_MS, ...rest } = {}) {
  const dvrSource = source || createDvrSource();
  if (typeof dvrSource.getSnapshot !== 'function' || typeof dvrSource.setDate !== 'function')
    throw new TypeError('DVR requires a date-controllable snapshot source');

  const inner = createImageryTileLayer({
    id: 'gibs-dvr',
    name: 'Planetary DVR — NASA True Color',
    icon: '⏪',
    sourceLabel: 'NASA GIBS',
    maximumLevel: GIBS_PRODUCTS.truecolor.maximumLevel,
    updateInterval,
    source: dvrSource,
    ...rest,
  });

  let _viewer = null;
  let _range = dvrDateRange({ days: DVR_DEFAULT_DAYS });
  let _lastGoodDate = null;
  let _unavailable = new Set();
  let _playing = false;
  let _playTimer = null;
  let _setTimeSeq = 0;

  function stopPlayback() {
    _playing = false;
    if (_playTimer) {
      clearInterval(_playTimer);
      _playTimer = null;
    }
  }

  async function setTime(dateStr, { probe = true } = {}) {
    if (!isValidGibsDate(dateStr))
      throw new TypeError(`DVR setTime: invalid date ${JSON.stringify(dateStr)}`);
    const seq = ++_setTimeSeq;
    const clamped = clampGibsDate(dateStr, _range);
    if (probe) {
      try {
        await dvrSource.probeDate(clamped);
      } catch (e) {
        if (seq !== _setTimeSeq) return { ok: false, stale: true };
        _unavailable.add(clamped);
        const err = new Error(`No GIBS frame for ${clamped}; kept ${_lastGoodDate || 'latest'}`);
        err.code = e.code || 'DVR_DATE_UNAVAILABLE';
        err.date = clamped;
        throw err;
      }
      if (seq !== _setTimeSeq) return { ok: false, stale: true };
      _unavailable.delete(clamped);
    }
    dvrSource.setDate(clamped);
    const ok = await inner.update(_viewer);
    if (seq !== _setTimeSeq) return { ok: false, stale: true };
    if (ok) {
      _lastGoodDate = clamped;
      return { ok: true, date: clamped };
    }
    // Provider attach failed: roll back to the last good frame.
    if (_lastGoodDate && _lastGoodDate !== clamped) {
      dvrSource.setDate(_lastGoodDate);
      await inner.update(_viewer);
    }
    const err = new Error(`DVR could not display ${clamped}; kept ${_lastGoodDate || 'latest'}`);
    err.code = 'DVR_DISPLAY_FAILED';
    err.date = clamped;
    throw err;
  }

  const layer = {
    id: inner.id,
    name: inner.name,
    icon: inner.icon,
    source: inner.source,
    updateInterval: inner.updateInterval,

    init(viewer) {
      inner.init(viewer);
      _viewer = viewer;
      _range = dvrDateRange({ days: DVR_DEFAULT_DAYS });
      _lastGoodDate = dvrSource.getDate();
      _unavailable = new Set();
      _playing = false;
      console.log('[Data:DVR] Initialized');
    },

    enable(viewer = _viewer) {
      inner.enable(viewer);
    },

    disable(viewer = _viewer) {
      stopPlayback();
      inner.disable(viewer);
    },

    /** Scheduled refresh: re-pin "live" mode to yesterday's frame. */
    update(viewer = _viewer) {
      if (dvrSource.isLive()) return inner.update(viewer);
      return Promise.resolve(false);
    },

    destroy(viewer = _viewer) {
      stopPlayback();
      inner.destroy(viewer);
      _viewer = null;
    },

    setTime,
    getTime: () => dvrSource.getDate(),
    isLive: () => dvrSource.isLive(),
    goLive: () => {
      stopPlayback();
      dvrSource.setLive();
      _lastGoodDate = dvrSource.getDate();
      return inner.update(_viewer);
    },
    getRange: () => _range,
    unavailableDates: () => [..._unavailable].sort(),
    clearUnavailable: () => {
      _unavailable.clear();
    },

    play() {
      if (_playing) return;
      _playing = true;
      _playTimer = setInterval(() => {
        const idx = dateToIndex(dvrSource.getDate(), _range);
        const next = indexToDate(idx + 1, _range);
        if (idx >= 0 && next === _range.max) {
          // Reached the newest frame: hold, then stop at live edge.
          void setTime(next).catch(() => {});
          stopPlayback();
          return;
        }
        void setTime(next).catch(() => {
          // Skip dates with no tiles during playback instead of stalling.
          const skip = indexToDate(idx + 2, _range);
          if (skip !== next) void setTime(skip).catch(() => stopPlayback());
          else stopPlayback();
        });
      }, PLAY_TICK_MS);
    },

    pause: stopPlayback,
    isPlaying: () => _playing,

    getStats() {
      return {
        ...inner.getStats(),
        date: dvrSource.getDate(),
        live: dvrSource.isLive(),
        playing: _playing,
        lastGoodDate: _lastGoodDate,
        unavailable: _unavailable.size,
        range: { min: _range.min, max: _range.max },
      };
    },
  };
  return layer;
}

const DVR_CSS = [
  'position:absolute;left:50%;bottom:18px;transform:translateX(-50%);',
  'display:flex;align-items:center;gap:10px;z-index:50;',
  'background:rgba(8,12,20,.82);border:1px solid rgba(120,180,255,.25);',
  'border-radius:12px;padding:8px 14px;color:#dfe9ff;',
  'font:12px/1.4 system-ui,sans-serif;backdrop-filter:blur(6px);',
  'box-shadow:0 4px 18px rgba(0,0,0,.45);user-select:none;',
].join('');

const BTN_CSS = [
  'background:rgba(90,140,255,.16);border:1px solid rgba(120,180,255,.35);',
  'color:#dfe9ff;border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12px;',
].join('');

/**
 * Build the scrubber control and attach it to `mount` (a positioned
 * container, e.g. the viewer wrapper). Returns `{ el, destroy, sync }`.
 */
export function createDvrControls(layer, { mount = document.body } = {}) {
  if (!layer || typeof layer.setTime !== 'function')
    throw new TypeError('createDvrControls requires a DVR layer');
  const range = layer.getRange();
  const el = document.createElement('div');
  el.className = 'dvr-scrubber';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Planetary DVR time scrubber');
  el.style.cssText = DVR_CSS;

  const playBtn = document.createElement('button');
  playBtn.textContent = '▶';
  playBtn.title = 'Play 30-day timelapse';
  playBtn.style.cssText = BTN_CSS;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(range.days.length - 1);
  slider.step = '1';
  slider.value = String(range.days.length - 1);
  slider.style.cssText = 'width:min(46vw,420px);accent-color:#6ea8ff;cursor:pointer;';
  slider.setAttribute('aria-label', 'DVR date');

  const dateLabel = document.createElement('span');
  dateLabel.style.cssText = 'min-width:86px;text-align:center;font-variant-numeric:tabular-nums;';

  const status = document.createElement('span');
  status.style.cssText = 'color:#ffb86b;min-width:0;max-width:220px;';

  const liveBtn = document.createElement('button');
  liveBtn.textContent = 'LIVE';
  liveBtn.title = 'Return to latest frame';
  liveBtn.style.cssText = BTN_CSS;

  el.append(playBtn, slider, dateLabel, liveBtn, status);
  mount.appendChild(el);

  let destroyed = false;

  function sync() {
    if (destroyed) return;
    const date = layer.getTime();
    const idx = dateToIndex(date, layer.getRange());
    if (idx >= 0) slider.value = String(idx);
    dateLabel.textContent = `${date}${layer.isLive() ? ' • LIVE' : ''}`;
    playBtn.textContent = layer.isPlaying() ? '⏸' : '▶';
    status.textContent = '';
  }

  function fail(message) {
    status.textContent = message;
    setTimeout(() => {
      if (!destroyed && status.textContent === message) status.textContent = '';
    }, 4000);
  }

  slider.addEventListener('input', () => {
    layer.pause();
    const date = indexToDate(Number(slider.value), layer.getRange());
    dateLabel.textContent = `${date} …`;
    layer
      .setTime(date)
      .then(() => sync())
      .catch((e) => {
        fail(e.code === 'DVR_DATE_UNAVAILABLE' ? `no frame ${e.date}` : 'frame failed');
        sync();
      });
  });

  playBtn.addEventListener('click', () => {
    if (layer.isPlaying()) layer.pause();
    else layer.play();
    sync();
  });

  liveBtn.addEventListener('click', () => {
    layer
      .goLive()
      .then(() => sync())
      .catch(() => fail('live frame failed'));
  });

  const syncTimer = setInterval(sync, 2000);
  sync();

  return {
    el,
    sync,
    destroy() {
      destroyed = true;
      clearInterval(syncTimer);
      layer.pause();
      el.remove();
    },
  };
}
