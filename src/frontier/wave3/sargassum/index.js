/**
 * Wave 3 / Track 3b — NOAA AOML Sargassum Watch mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Renders /api/sargassum as a dock panel: region chips that swap the
 * official NOAA AOML regional risk PNG (proxied same-origin), the shoreline
 * bar chart, and links to the official KMZ polygons + PDF report.
 *
 * Honesty: the PNGs are image renderings, not numerical data. This panel
 * performs no pixel analysis and makes no risk claims of its own.
 */
import * as Cesium from 'cesium';
import { escapeHtml, formatAnalysisDate } from './model.js';

const API = '/api/sargassum';
const REFRESH_MS = 30 * 60_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let statusEl = null;
    let panelEl = null;
    let doc = null;
    let activeCode = null;

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (destroyed || !enabled) return;
        doc = json;
        if (!activeCode || !json.regions.some((r) => r.code === activeCode)) {
          activeCode = json.regions[0]?.code ?? null;
        }
        render();
      } catch {
        if (statusEl) statusEl.textContent = 'sargassum data unavailable — retrying';
      }
    }

    function render() {
      if (!doc || !panelEl) return;
      if (statusEl) {
        statusEl.textContent =
          `analysis ${formatAnalysisDate(doc.analysisDate)}` +
          (doc.stale ? ' · stale' : '') +
          ' · NOAA AOML SIR';
      }
      const region = doc.regions.find((r) => r.code === activeCode) ?? doc.regions[0];
      const chips = doc.regions
        .map(
          (r) =>
            `<button data-region="${escapeHtml(r.code)}" ` +
            `style="font-size:10px;margin:0 3px 4px 0;padding:2px 7px;border-radius:9px;` +
            `border:1px solid #2a3b66;cursor:pointer;` +
            `${r.code === region?.code ? 'background:#2a3b66;color:#fff' : 'background:transparent;color:#8aa4d6'}">` +
            `${escapeHtml(r.code)}</button>`,
        )
        .join('');
      const img = region
        ? `<div style="font-size:10px;color:#c8d6f5;margin:2px 0">${escapeHtml(region.name)}</div>` +
          `<img src="${escapeHtml(region.proxiedImageUrl)}" alt="NOAA AOML Sargassum risk map: ${escapeHtml(region.name)}" ` +
          `style="width:100%;border-radius:6px;border:1px solid #1b2a4d">` +
          `<div style="font-size:9px;color:#5a6b8f;margin:2px 0">shoreline share (official)</div>` +
          `<img src="${escapeHtml(region.proxiedBarUrl)}" alt="shoreline percentage bar: ${escapeHtml(region.name)}" ` +
          `style="width:100%;border-radius:6px;border:1px solid #1b2a4d">`
        : '<div style="font-size:10px;color:#8aa4d6">no regions</div>';
      const links =
        `<div style="font-size:10px;margin-top:4px">` +
        `<a href="${escapeHtml(doc.kmzUrl)}" target="_blank" rel="noopener" style="color:#4dd0a6">KMZ polygons</a>` +
        ` · <a href="${escapeHtml(doc.pdfUrl)}" target="_blank" rel="noopener" style="color:#4dd0a6">PDF report</a></div>`;
      panelEl.innerHTML = chips + img + links;
      for (const btn of panelEl.querySelectorAll('[data-region]')) {
        btn.addEventListener('click', () => {
          activeCode = btn.getAttribute('data-region');
          render();
        });
      }
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
        statusEl.textContent = 'reading the sargassum belt…';
        mount.appendChild(statusEl);
        panelEl = document.createElement('div');
        panelEl.style.cssText = 'max-height:420px;overflow:auto;';
        mount.appendChild(panelEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('sargassum', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.sargassum') || 'Sargassum watch', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.sargassum') || 'Sargassum watch', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          'Maps are <b>NOAA AOML official image renderings</b>, not data feeds — ' +
          'this panel performs no pixel analysis and reports no numerical risk. ' +
          'The KMZ holds the real polygons.';
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
    console.warn('[wave3 sargassum] init failed:', error);
    return null;
  }
}
