/**
 * Wave 3 / Track 2a.4 — SWPC magnetosphere-glow mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Renders a translucent shell around the planet whose color, size, and
 * pulse rate follow the live planetary K-index, plus a dock ticker of
 * recent SWPC alert headlines. The glow is a Kp-driven visualization —
 * the legend says it is not a measured magnetosphere.
 */
import * as Cesium from 'cesium';
import { glowAlpha, glowPulseMs, glowRadii, kpColor, kpLabel } from './model.js';

const API = '/api/space-weather';
const REFRESH_MS = 2 * 60_000;

// re-export guard: model.js must export everything used here.
function glowColorSafe(kp) {
  try {
    return kpColor(kp);
  } catch {
    return '#8a93a6';
  }
}

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave3-space-weather');
    ds.show = false;
    viewer.dataSources.add(ds);

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let state = { kp: null, gScale: null, alerts: [] };

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (!res.ok) return;
        const doc = await res.json();
        if (destroyed || !enabled) return;
        state = doc;
        render(doc);
        updateStatus(doc);
      } catch {
        /* fail-soft */
      }
    }

    function render(doc) {
      ds.entities.removeAll();
      const kp = Number.isFinite(doc.kp) ? doc.kp : 0;
      const radii = glowRadii(kp);
      const base = glowAlpha(kp);
      const period = glowPulseMs(kp);
      const color = Cesium.Color.fromCssColorString(glowColorSafe(kp));
      ds.entities.add({
        position: Cesium.Cartesian3.ZERO,
        ellipsoid: new Cesium.EllipsoidGraphics({
          radii: new Cesium.Cartesian3(radii.x, radii.y, radii.z),
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              const k = 1 + 0.45 * Math.sin((2 * Math.PI * Date.now()) / period);
              return color.withAlpha(Math.min(0.65, base * k));
            }, false),
          ),
          outline: false,
        }),
      });
      // day-side compression hint: a second, slightly offset shell is
      // overkill — one breathing shell keeps the frame budget flat.
    }

    let statusEl = null;
    let tickerEl = null;
    function updateStatus(doc) {
      if (statusEl) {
        statusEl.textContent =
          kpLabel(doc) + (doc.stale ? ' · stale' : '');
      }
      if (tickerEl) {
        const alerts = (doc.alerts ?? []).slice(0, 4);
        tickerEl.innerHTML = alerts.length
          ? alerts
              .map(
                (a) =>
                  `<div>⚡ ${escapeHtml(a.code ?? 'ALERT')} — ${escapeHtml(a.headline ?? '')}</div>`,
              )
              .join('')
          : '<div style="opacity:.6">no SWPC alerts in the last 48h</div>';
      }
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[c]);
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
        statusEl.textContent = 'reading magnetometer…';
        mount.appendChild(statusEl);
        tickerEl = document.createElement('div');
        tickerEl.style.cssText =
          'font-size:10px;color:#c8d6f5;margin:2px 0;max-height:72px;overflow:hidden;line-height:1.5;';
        mount.appendChild(tickerEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('spaceWeather', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.spaceWeather') || 'Space weather', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.spaceWeather') || 'Space weather', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '<span style="color:#3ddc84">●</span> Kp 0–3 calm · ' +
          '<span style="color:#ffe14d">●</span> Kp 4 unsettled · ' +
          '<span style="color:#ff5a5a">●</span> Kp 5+ storm (G1+)<br>' +
          '<span style="opacity:.75">Shell is a Kp-driven visualization — ' +
          'not a measured magnetosphere. Source: NOAA SWPC.</span>';
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
    console.warn('[wave3 swpc] init failed:', error);
    return null;
  }
}
