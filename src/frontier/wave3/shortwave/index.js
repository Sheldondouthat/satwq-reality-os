/**
 * Wave 3 / Track 3b.9 — EiBi + WSPR shortwave oracle mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Renders the /api/shortwave-oracle document as a dock panel: MUF day/night
 * estimate, solar conditions, best-band callout, and a per-band table with
 * listenability bars. Everything score-like is labeled MODEL in the legend —
 * the only measured inputs are the WSPR spot counts and the EiBi schedule.
 */
import * as Cesium from 'cesium';
import { escapeHtml, fmtMhz, scoreColor, solarLine } from './model.js';

const API = '/api/shortwave-oracle';
const REFRESH_MS = 5 * 60_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let statusEl = null;
    let panelEl = null;

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (destroyed || !enabled) return;
        render(json);
      } catch {
        if (statusEl) statusEl.textContent = 'shortwave oracle unavailable — retrying';
      }
    }

    function render(o) {
      if (statusEl) {
        const bb = o.bestBand;
        statusEl.textContent =
          `${solarLine(o.solar)} · ` +
          (bb ? `best: ${bb.band} (${bb.score})` : 'no band data');
      }
      if (!panelEl) return;
      const muf = o.muf ?? {};
      const rows = (o.bands ?? [])
        .map((b) => {
          const color = scoreColor(b.score);
          const pct = b.score === null ? 0 : Math.max(2, b.score);
          const why = [
            b.wsprSpots30m ? `${b.wsprSpots30m} WSPR/30m` : null,
            b.eibiOnAir ? `${b.eibiOnAir} on-air` : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;font-size:10px">` +
            `<span style="width:34px;color:#c8d6f5">${escapeHtml(b.band)}</span>` +
            `<span style="flex:1;height:8px;background:#16213c;border-radius:4px;overflow:hidden">` +
            `<span style="display:block;height:100%;width:${pct}%;background:${color}"></span></span>` +
            `<span style="width:92px;color:#8aa4d6;text-align:right" title="${escapeHtml(why)}">` +
            `${escapeHtml(b.verdict)}</span></div>`
          );
        })
        .join('');
      const examples = (o.bands ?? [])
        .filter((b) => b.eibiExample)
        .slice(0, 4)
        .map(
          (b) =>
            `<div style="font-size:10px;color:#8aa4d6">📻 ${escapeHtml(b.band)}: ` +
            `${escapeHtml(b.eibiExample)}</div>`,
        )
        .join('');
      panelEl.innerHTML =
        `<div style="font-size:11px;color:#c8d6f5;margin:4px 0">` +
        `MUF (model): day <b>${escapeHtml(fmtMhz(muf.dayMufMhz))}</b> · ` +
        `night <b>${escapeHtml(fmtMhz(muf.nightMufMhz))}</b></div>` +
        rows +
        examples +
        `<div style="font-size:9px;color:#5a6b8f;margin-top:4px">` +
        `updated ${escapeHtml((o.generatedAt ?? '').replace('T', ' ').slice(0, 19))}Z</div>`;
    }

    function setEnabled(on) {
      enabled = on;
      if (on) {
        void load();
        refreshTimer = setInterval(load, REFRESH_MS);
      } else {
        clearInterval(refreshTimer);
      }
    }

    if (mount && typeof chip === 'function') {
      try {
        statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'reading the ionosphere…';
        mount.appendChild(statusEl);
        panelEl = document.createElement('div');
        panelEl.style.cssText = 'max-height:340px;overflow:auto;';
        mount.appendChild(panelEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('shortwave', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.shortwave') || 'Shortwave oracle', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.shortwave') || 'Shortwave oracle', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          'Scores = <b>heuristic model</b>: 50% measured WSPR activity, 20% EiBi ' +
          'schedule, 30% solar/day-night rule. Not measured reception at your ' +
          'location. MUF = rough empirical estimate, not an ionosonde.';
        mount.appendChild(legend);
      } catch {
        /* dock UI optional */
      }
    }

    return function destroy() {
      destroyed = true;
      setEnabled(false);
    };
  } catch (error) {
    console.warn('[wave3 shortwave] init failed:', error);
    return null;
  }
}
