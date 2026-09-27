/**
 * Wave 5 — UV index dock ticker.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`. No Cesium, no
 * globe entities: a clean dock ticker showing the current UV index with
 * its WHO band, today's max, and sunrise/sunset. Starts disabled (opt-in).
 * Uses the default coordinates baked into /api/uv.
 */
import { tickerSummary } from './model.js';

const API = '/api/uv';
const REFRESH_MS = 15 * 60_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (typeof document === 'undefined' || !mount || typeof chip !== 'function') return null;
    const T = typeof t === 'function' ? t : (k) => k;

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
    statusEl.textContent = 'UV ticker off — enable to load.';

    const valueEl = document.createElement('div');
    valueEl.style.cssText = 'font-size:22px;color:#cfe3ff;font-weight:600;letter-spacing:.5px;';

    const subEl = document.createElement('div');
    subEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;line-height:1.5;';

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (destroyed || !enabled) return;
        if (!res.ok) throw new Error(`http_${res.status}`);
        const payload = await res.json();
        const s = tickerSummary(payload);
        if (!s) throw new Error('bad_payload');
        valueEl.textContent = `${s.value} · ${s.band}`;
        valueEl.style.color = s.color;
        const bits = [];
        if (s.tempC !== null) bits.push(`${s.tempC}°C`);
        if (s.isDay === false) bits.push('night');
        if (s.todayMax) bits.push(s.todayMax);
        if (s.sun) bits.push(s.sun);
        bits.push('Open-Meteo (CC-BY 4.0)');
        subEl.textContent = bits.join(' · ');
        statusEl.textContent = 'live';
      } catch {
        if (!destroyed && enabled) {
          statusEl.textContent = 'unavailable — will retry';
          valueEl.textContent = '—';
        }
      }
    }

    function setEnabled(on) {
      enabled = on;
      clearInterval(refreshTimer);
      if (on) {
        statusEl.textContent = 'loading…';
        void load();
        refreshTimer = setInterval(load, REFRESH_MS);
      } else {
        statusEl.textContent = 'UV ticker off — enable to load.';
      }
    }

    mount.appendChild(statusEl);
    mount.appendChild(valueEl);
    mount.appendChild(subEl);
    mount.appendChild(chip(T('feature.uv') || 'UV index', setEnabled, false));
    const legend = document.createElement('div');
    legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
    legend.textContent =
      'Current UV index with WHO bands; today’s max, sunrise and sunset for the pinned point.';
    mount.appendChild(legend);

    return function destroy() {
      destroyed = true;
      clearInterval(refreshTimer);
      try {
        statusEl.remove();
        valueEl.remove();
        subEl.remove();
        legend.remove();
      } catch {
        /* already gone */
      }
    };
  } catch (error) {
    console.warn('[wave5 uv] init failed:', error);
    return null;
  }
}
