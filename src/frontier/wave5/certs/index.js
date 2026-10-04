/**
 * Wave 5 — certificate-transparency dock ticker.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`. No Cesium, no
 * globe entities: a clean dock ticker showing the cert count for the
 * queried domain plus the top-5 most recent certs with expiry horizons.
 * Starts disabled (opt-in). Rows are capped server-side (50).
 */
import { tickerSummary } from './model.js';

const API = '/api/certs';
const REFRESH_MS = 60 * 60_000; // provider caches 1h

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
    statusEl.textContent = 'cert ticker off — enable to load.';

    const valueEl = document.createElement('div');
    valueEl.style.cssText =
      'font-size:22px;color:#cfe3ff;font-weight:600;letter-spacing:.5px;';

    const listEl = document.createElement('div');
    listEl.style.cssText =
      'font-size:10px;color:#c8d6f5;margin:2px 0;line-height:1.7;';

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (destroyed || !enabled) return;
        if (!res.ok) throw new Error(`http_${res.status}`);
        const payload = await res.json();
        const s = tickerSummary(payload);
        if (!s) throw new Error('bad_payload');
        valueEl.textContent = `${s.value} · ${s.query}`;
        listEl.innerHTML = s.top.length
          ? s.top
              .map(
                (c) =>
                  `<div><span style="color:${c.color}">●</span> ` +
                  `${escapeHtml(c.commonName)} — ${escapeHtml(c.issuer)} ` +
                  `<span style="opacity:.7">(${escapeHtml(c.expiry)})</span></div>`,
              )
              .join('') +
            (s.capped ? '<div style="opacity:.6">row-capped at 50</div>' : '')
          : '<div style="opacity:.6">no logged certs</div>';
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
        statusEl.textContent = 'cert ticker off — enable to load.';
      }
    }

    mount.appendChild(statusEl);
    mount.appendChild(valueEl);
    mount.appendChild(listEl);
    mount.appendChild(
      chip(T('feature.certs') || 'Certificate transparency', setEnabled, false),
    );
    const legend = document.createElement('div');
    legend.style.cssText =
      'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
    legend.textContent =
      'Publicly logged certificates for the queried domain (crt.sh). Rows capped at 50; /api/certs?q= accepts other domains.';
    mount.appendChild(legend);

    return function destroy() {
      destroyed = true;
      clearInterval(refreshTimer);
      try {
        statusEl.remove();
        valueEl.remove();
        listEl.remove();
        legend.remove();
      } catch {
        /* already gone */
      }
    };
  } catch (error) {
    console.warn('[wave5 certs] init failed:', error);
    return null;
  }
}
