/**
 * Wave 5 — Biosphere observations ticker dock mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 * Renders a ticker list in the frontier dock and draws globe points
 * for observations that carry coordinates (iNaturalist + GBIF).
 */
import * as Cesium from 'cesium';
import {
  feedGlyph,
  hasCoords,
  observationSubtitle,
  observationsWithCoords,
  taxonColor,
} from './model.js';

const API = '/api/biosphere';
const REFRESH_MS = 30 * 60_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave5-biosphere');
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
        const payload = res.ok ? await res.json() : null;
        const items = Array.isArray(payload?.items) ? payload.items : [];
        renderPoints(observationsWithCoords(items).slice(0, 40));
        renderList(items, payload);
      } catch {
        /* fail-soft */
      }
    }

    function renderPoints(obs) {
      ds.entities.removeAll();
      for (const o of obs) {
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(o.lon, o.lat, 30_000),
          point: new Cesium.PointGraphics({
            pixelSize: 7,
            color: Cesium.Color.fromCssColorString(taxonColor(o.iconicTaxon)),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.7),
            outlineWidth: 1,
          }),
          label: new Cesium.LabelGraphics({
            text: `${feedGlyph(o.feed)} ${o.name ?? ''}`,
            font: '10px system-ui, sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -10),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              8_000_000,
            ),
          }),
          description:
            `<b>${escapeHtml(o.name ?? 'observation')}</b><br>` +
            (o.scientificName && o.scientificName !== o.name
              ? `<i>${escapeHtml(o.scientificName)}</i><br>`
              : '') +
            `Source: ${escapeHtml(o.feed ?? '')}<br>` +
            (o.observed
              ? `Observed: ${escapeHtml(String(o.observed).slice(0, 10))}<br>`
              : '') +
            (o.url
              ? `<a href="${escapeHtml(o.url)}" target="_blank" rel="noopener">record</a>`
              : ''),
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

    let listEl = null;
    let statusEl = null;
    function renderList(items, payload) {
      if (statusEl) {
        const degraded =
          Array.isArray(payload?.degradedSources) &&
          payload.degradedSources.length
            ? ` · degraded: ${payload.degradedSources.join(', ')}`
            : '';
        statusEl.textContent = `${items.length} observations (${observationsWithCoords(items).length} mapped)${degraded}`;
      }
      if (!listEl) return;
      if (!items.length) {
        listEl.innerHTML =
          '<div style="opacity:.6">biosphere feed unavailable</div>';
        return;
      }
      listEl.innerHTML = items
        .slice(0, 18)
        .map(
          (o) =>
            `<div style="margin:2px 0;line-height:1.5">` +
            `<span>${feedGlyph(o.feed)}</span> ` +
            (o.url
              ? `<a href="${escapeHtml(o.url)}" target="_blank" rel="noopener" ` +
                `style="color:#c8d6f5">${escapeHtml(o.name || '(unnamed)')}</a>`
              : `<span>${escapeHtml(o.name || '(unnamed)')}</span>`) +
            (hasCoords(o)
              ? ` <span style="opacity:.6">${o.lat.toFixed(2)}, ${o.lon.toFixed(2)}</span>`
              : '') +
            `<div style="opacity:.65">${escapeHtml(observationSubtitle(o))}</div>` +
            `</div>`,
        )
        .join('');
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
        statusEl.textContent = 'biosphere ticker: loading…';
        mount.appendChild(statusEl);
        listEl = document.createElement('div');
        listEl.style.cssText =
          'font-size:10px;color:#c8d6f5;max-height:220px;overflow-y:auto;';
        mount.appendChild(listEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('biosphere', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(
              T('feature.biosphere') || 'Biosphere ticker',
              (on) => (on ? tracked.show() : tracked.hide()),
              false,
            ),
          );
        } else {
          mount.appendChild(
            chip(T('feature.biosphere') || 'Biosphere ticker', apply, false),
          );
        }
        const legend = document.createElement('div');
        legend.style.cssText =
          'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '<span style="opacity:.75">iNaturalist + GBIF. Points fade beyond ' +
          '8,000 km. Click a point for the record link.</span>';
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
    console.warn('[wave5 biosphere] init failed:', error);
    return null;
  }
}
