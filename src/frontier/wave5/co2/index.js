/**
 * Wave 5 — CO₂ (Mauna Loa) dock ticker.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`. No Cesium, no
 * globe entities: a clean dock ticker showing the latest daily mean CO₂
 * and its year-ago delta. Starts disabled (opt-in chip).
 */
import { deltaLine, formatPpm, tickerSummary, trendGlyph } from './model.js';

const API = '/api/co2';
const REFRESH_MS = 60 * 60_000; // provider caches 6h; hourly refresh is plenty

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
}

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (typeof document === 'undefined' || !mount || typeof chip !== 'function')
      return null;
    const T = typeof t === 'function' ? t : (k) => k;

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
    statusEl.textContent = 'CO₂ ticker off — enable to load.';

    const valueEl = document.createElement('div');
    valueEl.style.cssText =
      'font-size:22px;color:#cfe3ff;font-weight:600;letter-spacing:.5px;';

    const deltaEl = document.createElement('div');
    deltaEl.style.cssText =
      'font-size:10px;color:#8aa4d6;margin:2px 0 4px;line-height:1.5;';

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (destroyed || !enabled) return;
        if (!res.ok) throw new Error(`http_${res.status}`);
        const payload = await res.json();
        const s = tickerSummary(payload);
        if (!s) throw new Error('bad_payload');
        valueEl.textContent = `${s.glyph} ${s.value}`;
        deltaEl.textContent =
          (s.delta ? `${s.delta} · ` : '') +
          (s.date ? `daily mean ${s.date} · ` : '') +
          'NOAA GML Mauna Loa';
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
        statusEl.textContent = 'CO₂ ticker off — enable to load.';
      }
    }

    mount.appendChild(statusEl);
    mount.appendChild(valueEl);
    mount.appendChild(deltaEl);
    mount.appendChild(
      chip(T('feature.co2') || 'CO₂ (Mauna Loa)', setEnabled, false),
    );
    const legend = document.createElement('div');
    legend.style.cssText =
      'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
    legend.textContent =
      'Daily mean CO₂ at Mauna Loa, NOAA Global Monitoring Laboratory (public domain).';
    mount.appendChild(legend);

    return function destroy() {
      destroyed = true;
      clearInterval(refreshTimer);
      try {
        statusEl.remove();
        valueEl.remove();
        deltaEl.remove();
        legend.remove();
      } catch {
        /* already gone */
      }
    };
  } catch (error) {
    console.warn('[wave5 co2] init failed:', error);
    return null;
  }
}

export const _co2TickerInternals = {
  formatPpm,
  trendGlyph,
  deltaLine,
  tickerSummary,
  escapeHtml,
};
