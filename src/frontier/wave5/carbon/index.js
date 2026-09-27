/**
 * Wave 5 — UK grid carbon intensity dock ticker.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`. No Cesium, no
 * globe entities: a clean dock ticker with the current GB intensity,
 * its ESO index band, and the half-hour window. Starts disabled (opt-in).
 */
import { tickerSummary } from './model.js';

const API = '/api/carbon';
const REFRESH_MS = 30 * 60_000; // half-hourly windows

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (typeof document === 'undefined' || !mount || typeof chip !== 'function') return null;
    const T = typeof t === 'function' ? t : (k) => k;

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
    statusEl.textContent = 'carbon ticker off — enable to load.';

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
        valueEl.textContent = `${s.value} · ${s.index}`;
        valueEl.style.color = s.color;
        subEl.textContent =
          (s.isForecast ? 'forecast · ' : 'measured · ') +
          (s.window ? `${s.window} · ` : '') +
          'GB grid — National Grid ESO';
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
        statusEl.textContent = 'carbon ticker off — enable to load.';
      }
    }

    mount.appendChild(statusEl);
    mount.appendChild(valueEl);
    mount.appendChild(subEl);
    mount.appendChild(
      chip(T('feature.carbon') || 'Grid carbon intensity', setEnabled, false),
    );
    const legend = document.createElement('div');
    legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
    legend.textContent =
      'Great Britain grid carbon intensity (half-hourly). Shows the measured value where published, else the ESO forecast — flagged.';
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
    console.warn('[wave5 carbon] init failed:', error);
    return null;
  }
}
