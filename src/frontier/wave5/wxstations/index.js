/**
 * Wave 5 — weather-station ticker globe mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Draws one colored point per station (color = temperature, size grows
 * with wind), click for details; dock lists per-source status + legend.
 * This is the ONLY file in wxstations that imports Cesium, so model.js
 * stays testable in plain Node.
 */
import * as Cesium from 'cesium';
import { fetchWxStations, kindNote, markerSize, stationLabel, tempColor } from './model.js';

const API_POLL_MS = 10 * 60_000;

export * from './model.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function stationDescription(s) {
  const rows = [
    ['Source', escapeHtml(s.source ?? '')],
    ['Kind', escapeHtml(kindNote(s.kind))],
    ['Temp', Number.isFinite(s.tempC) ? `${s.tempC.toFixed(1)} °C` : '—'],
    ['Wind', Number.isFinite(s.windMs)
      ? `${s.windMs.toFixed(1)} m/s${Number.isFinite(s.windDirDeg) ? ` @ ${Math.round(s.windDirDeg)}°` : ''}`
      : '—'],
    ['Humidity', Number.isFinite(s.rhPct) ? `${s.rhPct.toFixed(0)} %` : '—'],
    ['Pressure', Number.isFinite(s.pressureHpa) ? `${s.pressureHpa.toFixed(1)} hPa` : '—'],
  ];
  if (s.coordApprox) rows.push(['Position', 'network centroid — approximate']);
  if (s.timeMs) rows.push(['Observed', new Date(s.timeMs).toISOString()]);
  return `<b>${escapeHtml(s.name ?? s.id ?? '')}</b><br>` +
    rows.map(([k, v]) => `${escapeHtml(k)}: ${v}`).join('<br>');
}

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave5-wxstations');
    ds.show = false;
    viewer.dataSources.add(ds);

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let statusEl = null;

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const { stations, sources, stale, unavailable, reason } = await fetchWxStations();
        if (destroyed || !enabled) return;
        render(stations);
        updateStatus(stations.length, sources, stale, unavailable, reason);
      } catch {
        if (statusEl) statusEl.textContent = 'station sweep unavailable';
      }
    }

    function render(stations) {
      ds.entities.removeAll();
      for (const s of stations.slice(0, 200)) {
        const color = Cesium.Color.fromCssColorString(tempColor(s.tempC));
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 20_000),
          point: new Cesium.PointGraphics({
            pixelSize: markerSize(s.windMs),
            color,
            outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
            outlineWidth: 1.2,
          }),
          label: s.kind === 'station-index' ? undefined : new Cesium.LabelGraphics({
            text: stationLabel(s),
            font: '10px system-ui, sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -10),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 12_000_000),
          }),
          description: stationDescription(s),
        });
      }
    }

    function updateStatus(count, sources, stale, unavailable, reason) {
      if (!statusEl) return;
      if (unavailable) {
        statusEl.textContent = reason || 'station sweep unavailable';
        return;
      }
      const ok = sources.filter((s) => s.status === 'ok').length;
      statusEl.innerHTML =
        `${count} stations · ${ok}/${sources.length} sources${stale ? ' (stale)' : ''}<br>` +
        sources
          .map((s) => {
            const dot = s.status === 'ok' ? '#37c8ab' : '#ff5a5a';
            return `<span style="color:${dot}">●</span> ${escapeHtml(s.name)}: ` +
              `${s.status === 'ok' ? s.count : 'error'}`;
          })
          .join('<br>');
    }

    function setEnabled(on) {
      enabled = on;
      ds.show = on;
      if (on) {
        void load();
        refreshTimer = setInterval(load, API_POLL_MS);
      } else {
        clearInterval(refreshTimer);
      }
    }

    if (mount && typeof chip === 'function') {
      try {
        statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;line-height:1.6;';
        statusEl.textContent = 'loading station sweep…';
        mount.appendChild(statusEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('wxstations', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.wxstations') || 'Weather stations', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.wxstations') || 'Weather stations', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '<span style="color:#4da6ff">●</span> &lt;0°C · ' +
          '<span style="color:#37c8ab">●</span> 0–10 · ' +
          '<span style="color:#a3d65c">●</span> 10–20 · ' +
          '<span style="color:#ffb454">●</span> 20–30 · ' +
          '<span style="color:#ff5a5a">●</span> 30+<br>' +
          '<span style="opacity:.75">MET Norway = forecast; IPMA = locations only; ' +
          'centroid-pinned stations are approximate. Sources: NWS, MET Norway, ' +
          'SMHI, HKO, NEA, IPMA, IMGW, Met Éireann, IMO.</span>';
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
    console.warn('[wave5 wxstations] init failed:', error);
    return null;
  }
}
