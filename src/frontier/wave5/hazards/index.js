/**
 * Wave 5 / Track A — GDACS multi-hazard mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Multi-hazard globe markers colored by event type; dock lists ranked
 * events (live first, Red before Orange) with JRC severity text and links
 * to GDACS reports. Legend notes levels are analyst scores, not impact
 * predictions.
 */
import * as Cesium from 'cesium';
import { hazardColor, hazardGlyph, hazardLabel, rankHazards } from './model.js';

const API = '/api/hazards';
const REFRESH_MS = 30 * 60_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave5-hazards');
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
        const color = Cesium.Color.fromCssColorString(hazardColor(e.eventtype));
        const live = Boolean(e.iscurrent);
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(
            e.lon,
            e.lat,
            live ? 120_000 : 60_000,
          ),
          point: new Cesium.PointGraphics({
            pixelSize: e.alertlevel === 'Red' ? 14 : 10,
            color,
            outlineColor: Cesium.Color.WHITE.withAlpha(live ? 0.9 : 0.6),
            outlineWidth: live ? 2 : 1,
          }),
          label: live
            ? new Cesium.LabelGraphics({
                text: e.name ?? '',
                font: '10px system-ui, sans-serif',
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -10),
              })
            : undefined,
          description:
            `<b>${escapeHtml(e.name ?? 'Hazard event')}</b><br>` +
            `Type: ${escapeHtml(e.eventtype)} · Alert: ${escapeHtml(e.alertlevel ?? '—')}<br>` +
            (e.severityText ? `${escapeHtml(e.severityText)}<br>` : '') +
            (e.country ? `Country: ${escapeHtml(e.country)}<br>` : '') +
            (e.reportUrl
              ? `<a href="${escapeHtml(e.reportUrl)}" target="_blank" rel="noopener">GDACS report</a><br>`
              : '') +
            `<span style="opacity:.75">GDACS analyst severity score, not a local ` +
            `impact prediction.</span>`,
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
        statusEl.textContent =
          `${events.length} events · ${payload?.currentCount ?? 0} live` +
          (payload?.byType
            ? ' · ' +
              Object.entries(payload.byType)
                .map(([k, v]) => `${k}:${v}`)
                .join(' ')
            : '');
      }
      if (listEl) {
        const top = rankHazards(events).slice(0, 12);
        listEl.innerHTML = top.length
          ? top
              .map(
                (e) =>
                  `<div>${hazardGlyph(e.eventtype)} ` +
                  (e.reportUrl
                    ? `<a href="${escapeHtml(e.reportUrl)}" target="_blank" rel="noopener" style="color:#ffd23d">${escapeHtml(e.name ?? e.eventid)}</a>`
                    : escapeHtml(e.name ?? e.eventid)) +
                  `<br><span style="opacity:.8">${escapeHtml(hazardLabel(e))}</span>` +
                  (e.severityText
                    ? `<br><span style="opacity:.65">${escapeHtml(e.severityText)}</span>`
                    : '') +
                  `</div>`,
              )
              .join('')
          : '<div style="opacity:.6">no hazard events</div>';
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
        statusEl.textContent = 'loading hazards…';
        mount.appendChild(statusEl);
        listEl = document.createElement('div');
        listEl.style.cssText =
          'font-size:10px;color:#c8d6f5;margin:2px 0;line-height:1.6;';
        mount.appendChild(listEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('hazards', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(
              T('feature.hazards') || 'Multi-hazard events',
              (on) => (on ? tracked.show() : tracked.hide()),
              false,
            ),
          );
        } else {
          mount.appendChild(
            chip(T('feature.hazards') || 'Multi-hazard events', apply, false),
          );
        }
        const legend = document.createElement('div');
        legend.style.cssText =
          'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '🌐 EQ · 🌀 TC · 🌊 FL · 🔥 WF · 🌋 VO · 🏜️ DR<br>' +
          '● LIVE episodes get labels<br>' +
          '<span style="opacity:.75">Alert levels are GDACS/JRC analyst severity ' +
          'scores, not local impact predictions. Source: GDACS.</span>';
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
    console.warn('[wave5 hazards] init failed:', error);
    return null;
  }
}
