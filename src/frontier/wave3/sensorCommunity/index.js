/**
 * Wave 3 / Track 2a.3 — Sensor.Community haze-field mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Renders one translucent haze disc per outdoor citizen sensor, colored by
 * estimated AQI category (US EPA PM2.5 breakpoints — an estimate, labeled
 * as such). The query point follows the camera target (debounced); default
 * is a dense European sensor region until the user moves the globe.
 */
import * as Cesium from 'cesium';
import { aqiColor, hazeRadiusM, sensorLabel, summaryText } from './model.js';

const API = '/api/air-quality';
const DEFAULT = { lat: 51.05, lon: 3.72, r: 25 }; // Ghent, BE — dense sensor mesh
const REFRESH_MS = 5 * 60_000;

function viewCenter(viewer) {
  try {
    const carto = viewer.camera.positionCartographic;
    if (!carto) return null;
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    if (![lat, lon].every(Number.isFinite)) return null;
    // radius from camera height: wider when zoomed out, capped by API at 50 km
    const heightKm = carto.height / 1000;
    const r = Math.max(2, Math.min(50, heightKm / 60));
    return { lat: +lat.toFixed(3), lon: +lon.toFixed(3), r: +r.toFixed(1) };
  } catch {
    return null;
  }
}

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave3-air-quality');
    ds.show = false;
    viewer.dataSources.add(ds);

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let moveTimer = 0;
    let lastKey = '';

    async function load(center) {
      if (destroyed || !enabled) return;
      try {
        const q = `lat=${center.lat}&lon=${center.lon}&r=${center.r}`;
        const res = await fetch(`${API}?${q}`);
        if (!res.ok) return;
        const doc = await res.json();
        if (destroyed || !enabled) return;
        render(doc.sensors ?? []);
        updateStatus(doc);
      } catch {
        /* fail-soft */
      }
    }

    function render(sensors) {
      ds.entities.removeAll();
      for (const s of sensors.slice(0, 1500)) {
        if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
        const color = Cesium.Color.fromCssColorString(
          aqiColor(s.aqi),
        ).withAlpha(0.22);
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 0),
          ellipse: new Cesium.EllipseGraphics({
            semiMajorAxis: hazeRadiusM(s.aqi),
            semiMinorAxis: hazeRadiusM(s.aqi),
            material: color,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          }),
          description: sensorLabel(s),
        });
      }
    }

    function requestCenter() {
      const c = viewCenter(viewer) ?? DEFAULT;
      const key = `${c.lat},${c.lon},${c.r}`;
      if (key === lastKey) return;
      lastKey = key;
      void load(c);
    }

    const onMoveEnd = () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(requestCenter, 1200);
    };

    function setEnabled(on) {
      enabled = on;
      ds.show = on;
      if (on) {
        requestCenter();
        refreshTimer = setInterval(requestCenter, REFRESH_MS);
        viewer.camera.moveEnd.addEventListener(onMoveEnd);
      } else {
        clearInterval(refreshTimer);
        viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      }
    }

    let statusEl = null;
    function updateStatus(doc) {
      if (!statusEl) return;
      statusEl.textContent =
        summaryText(doc.summary) + (doc.stale ? ' · stale' : '');
    }

    if (mount && typeof chip === 'function') {
      try {
        statusEl = document.createElement('div');
        statusEl.style.cssText =
          'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'loading sensors…';
        mount.appendChild(statusEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('airQuality', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(
              T('feature.airQuality') || 'Air-quality haze',
              (on) => (on ? tracked.show() : tracked.hide()),
              false,
            ),
          );
        } else {
          mount.appendChild(
            chip(T('feature.airQuality') || 'Air-quality haze', apply, false),
          );
        }
        const legend = document.createElement('div');
        legend.style.cssText =
          'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '<span style="color:#3ddc84">●</span> Good · ' +
          '<span style="color:#ffe14d">●</span> Moderate · ' +
          '<span style="color:#ff9f43">●</span> USG · ' +
          '<span style="color:#ff5a5a">●</span> Unhealthy · ' +
          '<span style="color:#b366ff">●</span> Very unhealthy · ' +
          '<span style="color:#8b1a3d">●</span> Hazardous<br>' +
          '<span style="opacity:.75">Citizen sensors (Sensor.Community). ' +
          'Categories = US EPA PM2.5 breakpoints, estimate only.</span>';
        mount.appendChild(legend);
      } catch {
        /* dock UI optional */
      }
    }

    return function destroy() {
      destroyed = true;
      setEnabled(false);
      clearTimeout(moveTimer);
      try {
        viewer.dataSources.remove(ds, true);
      } catch {
        /* already gone */
      }
    };
  } catch (error) {
    console.warn('[wave3 sensorCommunity] init failed:', error);
    return null;
  }
}
