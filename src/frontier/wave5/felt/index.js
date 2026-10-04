/**
 * Wave 5 / Track A — EMSC felt-earthquake mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Renders felt-earthquake globe points: SIZE encodes crowd-sourced
 * testimony volume (sqrt-scaled), COLOR encodes instrumental magnitude.
 * The dock lists the top-10 events by testimonyCount with links to the
 * EMSC event pages. Crowd-sourced honesty label in the legend.
 */
import * as Cesium from 'cesium';
import { feltLabel, magColor, testimonySize, topFelt } from './model.js';

const API = '/api/felt';
const REFRESH_MS = 30 * 60_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave5-felt');
    ds.show = false;
    viewer.dataSources.add(ds);

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (destroyed || !enabled) return;
        const payload = res.ok ? await res.json() : { events: [] };
        render(payload.events ?? []);
        updateStatus(payload);
      } catch {
        /* fail-soft */
      }
    }

    function render(events) {
      ds.entities.removeAll();
      for (const e of events.slice(0, 300)) {
        if (!Number.isFinite(e.lon) || !Number.isFinite(e.lat)) continue;
        const color = Cesium.Color.fromCssColorString(magColor(e.mag));
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(e.lon, e.lat, 50_000),
          point: new Cesium.PointGraphics({
            pixelSize: testimonySize(e.testimonyCount),
            color,
            outlineColor: Cesium.Color.WHITE.withAlpha(0.7),
            outlineWidth: 1,
          }),
          description:
            `<b>${escapeHtml(e.name ?? 'Felt earthquake')}</b><br>` +
            `Magnitude: ${Number.isFinite(e.mag) ? e.mag.toFixed(1) : '—'}<br>` +
            `Depth: ${Number.isFinite(e.depthKm) ? e.depthKm.toFixed(1) + ' km' : '—'}<br>` +
            `Felt testimonies: <b>${e.testimonyCount ?? 0}</b><br>` +
            `<a href="${escapeHtml(e.url ?? '')}" target="_blank" rel="noopener">EMSC event page</a><br>` +
            `<span style="opacity:.75">Testimonies are crowd-sourced self-reports, ` +
            `not instrumental intensity.</span>`,
        });
      }
    }

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

    let statusEl = null;
    let listEl = null;
    function updateStatus(payload) {
      const events = payload?.events ?? [];
      if (statusEl) {
        statusEl.textContent = `${events.length} felt quakes (72h) · ${payload?.totalTestimonies ?? 0} testimonies`;
      }
      if (listEl) {
        const top = topFelt(events, 10);
        listEl.innerHTML = top.length
          ? top
              .map(
                (e) =>
                  `<div><a href="${escapeHtml(e.url ?? '#')}" target="_blank" rel="noopener" ` +
                  `style="color:#ffd23d">${escapeHtml(e.name ?? e.id)}</a><br>` +
                  `<span style="opacity:.8">${escapeHtml(feltLabel(e))}</span></div>`,
              )
              .join('')
          : '<div style="opacity:.6">no felt reports in window</div>';
      }
    }

    function setEnabled(on) {
      enabled = on;
      ds.show = on;
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
        statusEl.style.cssText =
          'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'loading felt quakes…';
        mount.appendChild(statusEl);
        listEl = document.createElement('div');
        listEl.style.cssText =
          'font-size:10px;color:#c8d6f5;margin:2px 0;line-height:1.6;';
        mount.appendChild(listEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('felt', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(
              T('feature.felt') || 'Felt earthquakes',
              (on) => (on ? tracked.show() : tracked.hide()),
              false,
            ),
          );
        } else {
          mount.appendChild(
            chip(T('feature.felt') || 'Felt earthquakes', apply, false),
          );
        }
        const legend = document.createElement('div');
        legend.style.cssText =
          'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          'point size = testimony volume (crowd-sourced)<br>' +
          'color = magnitude<br>' +
          '<span style="opacity:.75">Testimonies are self-reported, not instrumental ' +
          'intensity. Source: EMSC.</span>';
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
    console.warn('[wave5 felt] init failed:', error);
    return null;
  }
}
