/**
 * Wave 3 / Track 2a.2 — NWPS forecast-ribbon mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Draws flood-wave forecast ribbons: for each seeded NHDPlus COMID the
 * provider returns the reach plus its immediate neighbors, and the client
 * draws a polyline ribbon through them colored by forecast flow trend
 * (NOAA National Water Model output — a model, labeled as such).
 * Animated dashes suggest forecast direction of travel.
 */
import * as Cesium from 'cesium';
import { meanTrend, orderRibbon, trendColor, trendLabel } from './model.js';

const API = '/api/nwps';
// Seed COMIDs are provider-verified live; neighbors are discovered via the
// reach `route` block, so one seed grows a small river ribbon.
const SEED_COMIDS = ['101'];
const SERIES = 'short_range';
const REFRESH_MS = 30 * 60_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave3-nwps');
    ds.show = false;
    viewer.dataSources.add(ds);

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(
          `${API}?comid=${SEED_COMIDS.join(',')}&series=${SERIES}`,
        );
        if (!res.ok) return;
        const doc = await res.json();
        if (destroyed || !enabled) return;
        render(doc.reaches ?? []);
        updateStatus(doc);
      } catch {
        /* fail-soft */
      }
    }

    function render(reaches) {
      ds.entities.removeAll();
      const nodes = orderRibbon(reaches.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)));
      if (nodes.length >= 2) {
        const positions = nodes.map((n) =>
          Cesium.Cartesian3.fromDegrees(n.lon, n.lat, 800),
        );
        ds.entities.add({
          polyline: new Cesium.PolylineGraphics({
            positions,
            width: 7,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString('#7cc4ff').withAlpha(0.85),
              dashLength: 24,
            }),
            clampToGround: true,
          }),
        });
      }
      for (const n of nodes) {
        const color = Cesium.Color.fromCssColorString(trendColor(n.trendPct));
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(n.lon, n.lat, 1200),
          point: new Cesium.PointGraphics({
            pixelSize: 11,
            color,
            outlineColor: Cesium.Color.WHITE.withAlpha(0.7),
            outlineWidth: 1.5,
          }),
          label: new Cesium.LabelGraphics({
            text: `${n.name}\n${trendLabel(n.trendPct)}`,
            font: '11px system-ui, sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -14),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4_000_000),
          }),
          description:
            `<b>${escapeHtml(n.name)}</b><br>` +
            `Reach ${escapeHtml(n.reachId)} · NWM ${escapeHtml(SERIES)}<br>` +
            `Forecast trend: ${escapeHtml(trendLabel(n.trendPct))}<br>` +
            (Number.isFinite(n.peakFlow)
              ? `Peak forecast flow: ${n.peakFlow.toFixed(1)} ${escapeHtml(n.units ?? '')}<br>`
              : '') +
            `<span style="opacity:.75">NOAA National Water Model output — model, not observation.</span>`,
        });
      }
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[c]);
    }

    let statusEl = null;
    function updateStatus(doc) {
      if (!statusEl) return;
      const mt = meanTrend(doc.reaches ?? []);
      statusEl.textContent =
        `${doc.reaches?.length ?? 0} reaches` +
        (mt != null ? ` · mean ${trendLabel(mt)}` : '') +
        (doc.stale ? ' · stale' : '');
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
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'loading NWM forecast…';
        mount.appendChild(statusEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('nwps', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.nwps') || 'Flood-wave forecast', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.nwps') || 'Flood-wave forecast', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '<span style="color:#ef4444">●</span> rising forecast · ' +
          '<span style="color:#cbd5e1">●</span> flat · ' +
          '<span style="color:#2dd4bf">●</span> falling<br>' +
          '<span style="opacity:.75">NOAA National Water Model output — ' +
          'model forecast, not observed flooding.</span>';
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
    console.warn('[wave3 nwps] init failed:', error);
    return null;
  }
}
