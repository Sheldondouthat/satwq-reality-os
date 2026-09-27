/**
 * Wave 5 / Track A — volcano alert-ticker mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Globe points at every known volcano position (GeoNet NZ full list +
 * AVO elevated), colored by current alert color; the dock runs a ticker
 * cycling the ELEVATED-alert volcanoes with their status text. Honesty
 * line: quiet in these feeds ≠ global all-clear.
 */
import * as Cesium from 'cesium';
import { levelColor, noElevated, rankActive, tickerLabel, tickerStatus } from './model.js';

const API = '/api/volcano';
const REFRESH_MS = 30 * 60_000;
const TICKER_MS = 4_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave5-volcano');
    ds.show = false;
    viewer.dataSources.add(ds);

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let tickerTimer = 0;
    let ranked = [];
    let tickerIdx = 0;

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (destroyed || !enabled) return;
        const payload = res.ok ? await res.json() : { geonet: { volcanoes: [] }, avo: { volcanoes: [] }, active: [], warnings: [] };
        render(payload);
        updateStatus(payload);
      } catch {
        /* fail-soft */
      }
    }

    function render(payload) {
      ds.entities.removeAll();
      const all = [
        ...(payload?.geonet?.volcanoes ?? []).map((v) => ({ ...v, isActive: false })),
        ...(payload?.active ?? []).map((v) => ({ ...v, isActive: true })),
      ];
      const seen = new Set();
      for (const v of all) {
        if (!Number.isFinite(v.lon) || !Number.isFinite(v.lat) || seen.has(v.id)) continue;
        seen.add(v.id);
        const color = Cesium.Color.fromCssColorString(levelColor(v.color));
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.isActive ? 150_000 : 50_000),
          point: new Cesium.PointGraphics({
            pixelSize: v.isActive ? 16 : 8,
            color,
            outlineColor: Cesium.Color.WHITE.withAlpha(v.isActive ? 0.9 : 0.5),
            outlineWidth: v.isActive ? 2 : 1,
          }),
          description:
            `<b>${escapeHtml(v.name ?? 'Volcano')}</b><br>` +
            `Status: <b>${escapeHtml(String(v.color ?? '—'))}</b>` +
            (v.levelText ? `<br>${escapeHtml(v.levelText)}` : '') +
            (v.region ? `<br>Region: ${escapeHtml(v.region)}` : '') +
            (v.url ? `<br><a href="${escapeHtml(v.url)}" target="_blank" rel="noopener">event page</a>` : ''),
        });
      }
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[c]);
    }

    let statusEl = null;
    let tickerEl = null;
    let detailEl = null;

    function tick() {
      if (destroyed || !tickerEl) return;
      if (!ranked.length) {
        tickerEl.textContent = 'no elevated alerts';
        if (detailEl) detailEl.textContent = '';
        return;
      }
      const entry = ranked[tickerIdx % ranked.length];
      tickerIdx += 1;
      const color = levelColor(entry.color);
      tickerEl.innerHTML =
        `🌋 <b style="color:${color}">${escapeHtml(tickerLabel(entry))}</b>`;
      if (detailEl) detailEl.textContent = entry.levelText ?? '';
    }

    function updateStatus(payload) {
      ranked = rankActive(payload?.active ?? []);
      tickerIdx = 0;
      if (statusEl) {
        statusEl.textContent = `volcano watch · ${tickerStatus(payload?.activeCount ?? ranked.length, payload?.warnings ?? [])}`;
      }
      tick();
    }

    function setEnabled(on) {
      enabled = on;
      ds.show = on;
      if (on) {
        void load();
        refreshTimer = setInterval(load, REFRESH_MS);
        tickerTimer = setInterval(tick, TICKER_MS);
      } else {
        clearInterval(refreshTimer);
        clearInterval(tickerTimer);
      }
    }

    if (mount && typeof chip === 'function') {
      try {
        statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'loading volcano alerts…';
        mount.appendChild(statusEl);
        tickerEl = document.createElement('div');
        tickerEl.style.cssText =
          'font-size:12px;color:#e8eefc;margin:6px 0;padding:6px;border:1px solid #2a3a5f;border-radius:6px;background:#0d1426;min-height:18px;';
        tickerEl.textContent = '…';
        mount.appendChild(tickerEl);
        detailEl = document.createElement('div');
        detailEl.style.cssText = 'font-size:10px;color:#8aa4d6;line-height:1.5;';
        mount.appendChild(detailEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('volcano', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.volcano') || 'Volcano alerts', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.volcano') || 'Volcano alerts', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '<span style="color:#3ddc84">●</span> normal · ' +
          '<span style="color:#ffd23d">●</span> elevated · ' +
          '<span style="color:#ff8a3d">●</span> high · ' +
          '<span style="color:#ff4d4d">●</span> critical<br>' +
          '<span style="opacity:.75">NZ feed: GeoNet VAL (GNS Science). Alaska feed: ' +
          'AVO front page — elevated alerts only. Quiet here ≠ global all-clear.</span>';
        mount.appendChild(legend);
      } catch {
        /* dock UI optional */
      }
    }

    return function destroy() {
      destroyed = true;
      setEnabled(false);
      try {
        viewer.dataSources.remove(ds, true);
      } catch {
        /* already gone */
      }
    };
  } catch (error) {
    console.warn('[wave5 volcano] init failed:', error);
    return null;
  }
}
