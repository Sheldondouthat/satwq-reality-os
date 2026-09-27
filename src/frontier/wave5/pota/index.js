/**
 * Wave 5 — POTA "who's on the air" globe layer.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Plots live POTA activator spots as globe points (color by mode, label
 * with callsign/band). The dock shows a mode filter and the newest spots.
 * Spots are live self/spotter reports; park coords are the registered park
 * location — the legend says so.
 */
import * as Cesium from 'cesium';
import { modeColor, bandLabel, spotAge, spotLabel, plottableSpots, escapeHtml } from './model.js';

const API = '/api/pota';
const REFRESH_MS = 5 * 60_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave5-pota');
    ds.show = false;
    viewer.dataSources.add(ds);

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let modeFilter = '';

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(`${API}?limit=300`);
        if (destroyed || !enabled) return;
        const payload = res.ok ? await res.json() : null;
        const spots = plottableSpots(payload?.spots);
        render(spots);
        updateStatus(payload, spots);
      } catch {
        /* fail-soft */
      }
    }

    function render(spots) {
      ds.entities.removeAll();
      const shown = modeFilter
        ? spots.filter((s) => String(s.mode).toUpperCase() === modeFilter)
        : spots;
      for (const spot of shown.slice(0, 300)) {
        const color = Cesium.Color.fromCssColorString(modeColor(spot.mode));
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat, 60_000),
          point: new Cesium.PointGraphics({
            pixelSize: 7,
            color,
            outlineColor: Cesium.Color.WHITE.withAlpha(0.7),
            outlineWidth: 1,
          }),
          label: new Cesium.LabelGraphics({
            text: spotLabel(spot),
            font: '10px system-ui, sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -10),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 12_000_000),
          }),
          description:
            `<b>${escapeHtml(spot.activator)}</b> @ ${escapeHtml(spot.reference)}<br>` +
            `${escapeHtml(spot.name)}<br>` +
            `${escapeHtml(bandLabel(spot.frequencyKhz))} · ${escapeHtml(spot.mode)} · ` +
            `${Number.isFinite(spot.frequencyKhz) ? (spot.frequencyKhz / 1000).toFixed(3) + ' MHz' : '—'}<br>` +
            `Spotted ${escapeHtml(spotAge(spot.spotTime))} via ${escapeHtml(spot.spotter || spot.source)}<br>` +
            `<span style="opacity:.75">Park coords = registered location, may lag new refs. ` +
            `Spots are live self/spotter reports.</span>`,
        });
      }
    }

    let statusEl = null;
    let listEl = null;
    function updateStatus(payload, spots) {
      if (statusEl) {
        const c = payload?.count ?? 0;
        const w = payload?.withCoords ?? spots.length;
        statusEl.textContent = `${c} spots · ${w} with park coords`;
      }
      if (listEl) {
        const newest = [...spots]
          .sort((a, b) => new Date(b.spotTime) - new Date(a.spotTime))
          .slice(0, 5);
        listEl.innerHTML = newest.length
          ? newest.map((s) =>
              `<div><span style="color:${modeColor(s.mode)}">●</span> ` +
              `${escapeHtml(spotLabel(s))} <span style="opacity:.6">${escapeHtml(spot.reference)} · ` +
              `${escapeHtml(spotAge(s.spotTime))}</span></div>`).join('')
          : '<div style="opacity:.6">no spots right now</div>';
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
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'listening for activators…';
        mount.appendChild(statusEl);
        listEl = document.createElement('div');
        listEl.style.cssText = 'font-size:10px;color:#c8d6f5;margin:2px 0;line-height:1.5;';
        mount.appendChild(listEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('pota', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.pota') || "Who's on the air (POTA)", (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.pota') || "Who's on the air (POTA)", apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '<span style="color:#ffb454">●</span> CW · ' +
          '<span style="color:#4dd0a6">●</span> SSB · ' +
          '<span style="color:#6aa8ff">●</span> digital/FM<br>' +
          '<span style="opacity:.75">Live spots via api.pota.app; park coords = ' +
          'registered location (may lag new refs).</span>';
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
    console.warn('[wave5 pota] init failed:', error);
    return null;
  }
}
