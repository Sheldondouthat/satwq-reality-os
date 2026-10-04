/**
 * Wave 5 — SatNOGS ground-station globe layer.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Plots SatNOGS network ground stations as globe points (color by derived
 * status); the description lists each station's antenna frequency ranges.
 * Antenna ranges are station-declared capability, not live measurements —
 * the legend says so.
 */
import * as Cesium from 'cesium';
import {
  statusColor,
  antennaRangeLabel,
  antennaSummary,
  stationLine,
  plottableStations,
  escapeHtml,
} from './model.js';

const API = '/api/satnogs?dataset=stations&limit=1000';
const REFRESH_MS = 30 * 60_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave5-satnogs');
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
        const stations = plottableStations(payload?.stations);
        render(stations);
        updateStatus(payload, stations);
      } catch {
        /* fail-soft */
      }
    }

    function render(stations) {
      ds.entities.removeAll();
      for (const station of stations.slice(0, 500)) {
        const color = Cesium.Color.fromCssColorString(
          statusColor(station.status),
        );
        const antennas = (station.antennas ?? []).map(antennaSummary);
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(
            station.lng,
            station.lat,
            40_000,
          ),
          point: new Cesium.PointGraphics({
            pixelSize: 6,
            color,
            outlineColor: Cesium.Color.WHITE.withAlpha(0.7),
            outlineWidth: 1,
          }),
          label: new Cesium.LabelGraphics({
            text: station.name,
            font: '10px system-ui, sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -9),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              12_000_000,
            ),
          }),
          description:
            `<b>${escapeHtml(station.name)}</b> (#${escapeHtml(String(station.id))})<br>` +
            `${escapeHtml(stationLine(station))}<br>` +
            (station.qthLocator
              ? `QTH locator: ${escapeHtml(station.qthLocator)}<br>`
              : '') +
            (antennas.length
              ? 'Antennas:<br>' +
                antennas
                  .map((a) => `&nbsp;&nbsp;📡 ${escapeHtml(a)}`)
                  .join('<br>') +
                '<br>'
              : '') +
            (station.lastSeen
              ? `Last seen: ${escapeHtml(station.lastSeen)}<br>`
              : '') +
            `<span style="opacity:.75">Antenna ranges are station-declared capability, ` +
            `not live measurements. Status derived from observation counts.</span>`,
        });
      }
    }

    let statusEl = null;
    function updateStatus(payload, stations) {
      if (statusEl) {
        const observed = stations.filter((s) => s.status === 'observed').length;
        statusEl.textContent = `${payload?.count ?? 0} stations · ${observed} observed · ${payload?.withAntennas ?? 0} with antenna ranges`;
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
        statusEl.textContent = 'scanning ground stations…';
        mount.appendChild(statusEl);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('satnogs', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(
              T('feature.satnogs') || 'Ground stations (SatNOGS)',
              (on) => (on ? tracked.show() : tracked.hide()),
              false,
            ),
          );
        } else {
          mount.appendChild(
            chip(
              T('feature.satnogs') || 'Ground stations (SatNOGS)',
              (on) => setEnabled(on),
              false,
            ),
          );
        }
        const legend = document.createElement('div');
        legend.style.cssText =
          'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '<span style="color:#4dd0a6">●</span> observed · ' +
          '<span style="color:#ffb454">●</span> scheduled · ' +
          '<span style="color:#8a93a6">●</span> idle<br>' +
          '<span style="opacity:.75">Antenna ranges = station-declared capability; ' +
          'status from observation counts. Source: SatNOGS network.</span>';
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
    console.warn('[wave5 satnogs] init failed:', error);
    return null;
  }
}
