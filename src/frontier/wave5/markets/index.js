/**
 * Wave 5 — markets dock ticker (FX + BTC).
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`. No Cesium, no
 * globe entities: a clean dock ticker with the BTC median across live
 * legs, the EUR→USD cross from the ECB daily rate, and honest per-source
 * degraded flags. Starts disabled (opt-in). CoinGecko is never retried —
 * the provider degrades that leg in place.
 */
import { tickerSummary } from './model.js';

const API = '/api/markets';
const REFRESH_MS = 5 * 60_000; // matches the provider TTL (CoinGecko gentle)

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
    statusEl.textContent = 'markets ticker off — enable to load.';

    const valueEl = document.createElement('div');
    valueEl.style.cssText =
      'font-size:22px;color:#cfe3ff;font-weight:600;letter-spacing:.5px;';

    const legsEl = document.createElement('div');
    legsEl.style.cssText =
      'font-size:10px;color:#c8d6f5;margin:2px 0;line-height:1.6;';

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (destroyed || !enabled) return;
        if (!res.ok) throw new Error(`http_${res.status}`);
        const payload = await res.json();
        const s = tickerSummary(payload);
        if (!s) throw new Error('bad_payload');
        valueEl.textContent = `BTC ${s.btcMedian}`;
        const rows = [];
        for (const l of s.liveLegs)
          rows.push(`${escapeHtml(l.label)} ${escapeHtml(l.price)}`);
        const legsHtml = rows.length
          ? rows.join(' · ')
          : '<span style="opacity:.6">no live BTC legs</span>';
        const fxHtml = s.fxDegraded
          ? '<span style="opacity:.6">FX unavailable</span>'
          : `FX ${escapeHtml(s.fxEur)}${s.fxDate ? ` (${escapeHtml(s.fxDate)}, ECB daily)` : ''}`;
        const degHtml = s.degradedLegs.length
          ? `<br><span style="color:#f5a542">degraded: ${s.degradedLegs.map(escapeHtml).join(', ')}</span>`
          : '';
        legsEl.innerHTML = `${legsHtml}<br>${fxHtml}${degHtml}`;
        statusEl.textContent = s.anyDegraded ? 'partial' : 'live';
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
        statusEl.textContent = 'markets ticker off — enable to load.';
      }
    }

    mount.appendChild(statusEl);
    mount.appendChild(valueEl);
    mount.appendChild(legsEl);
    mount.appendChild(
      chip(T('feature.markets') || 'Markets (FX · BTC)', setEnabled, false),
    );
    const legend = document.createElement('div');
    legend.style.cssText =
      'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
    legend.textContent =
      'BTC median across live spot legs; FX is the ECB daily reference rate. Degraded legs are shown, never filled in.';
    mount.appendChild(legend);

    return function destroy() {
      destroyed = true;
      clearInterval(refreshTimer);
      try {
        statusEl.remove();
        valueEl.remove();
        legsEl.remove();
        legend.remove();
      } catch {
        /* already gone */
      }
    };
  } catch (error) {
    console.warn('[wave5 markets] init failed:', error);
    return null;
  }
}
