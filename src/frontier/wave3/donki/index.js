/**
 * Wave 3 / Track 2a.5 — DONKI CME-arc mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * For each Earth-directed CME (provider heuristic) draws a cinematic arc
 * from the Sun side toward Earth with an ETA countdown label. Also lists
 * recent flares (FLR) in the dock. Earth-directedness and ETA are MODELS —
 * the legend says so.
 */
import * as Cesium from 'cesium';
import { arcSamples, cmeLabel, etaCountdown, speedColor, subsolarPoint } from './model.js';

const API = '/api/donki';
const DAYS = 30;
const REFRESH_MS = 30 * 60_000;
const SUN_DISTANCE_M = 30_000_000; // cinematic: sun placed 30,000 km out along the sun line

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave3-donki');
    ds.show = false;
    viewer.dataSources.add(ds);

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let tickTimer = 0;

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const [cmeRes, flrRes] = await Promise.all([
          fetch(`${API}?type=CME&days=${DAYS}`),
          fetch(`${API}?type=FLR&days=${DAYS}`),
        ]);
        if (destroyed || !enabled) return;
        const cmes = cmeRes.ok ? (await cmeRes.json()).events ?? [] : [];
        const flares = flrRes.ok ? (await flrRes.json()).events ?? [] : [];
        render(cmes.filter((c) => c.earthDirected).slice(0, 8));
        updateStatus(cmes, flares);
      } catch {
        /* fail-soft */
      }
    }

    function render(cmes) {
      ds.entities.removeAll();
      const sun = subsolarPoint(new Date());
      for (const cme of cmes) {
        if (!Number.isFinite(cme.etaMs)) continue;
        const impact = { lon: sun.lon, lat: sun.lat * 0.4, h: 400_000 };
        const start = { lon: sun.lon, lat: sun.lat, h: SUN_DISTANCE_M };
        const samples = arcSamples(start, impact, 48);
        const positions = samples.map(([lo, la, h]) =>
          Cesium.Cartesian3.fromDegrees(lo, la, Math.max(50_000, h)),
        );
        const color = Cesium.Color.fromCssColorString(speedColor(cme.speedKms));
        ds.entities.add({
          polyline: new Cesium.PolylineGraphics({
            positions,
            width: 3,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.35,
              color: color.withAlpha(0.9),
            }),
          }),
        });
        // impact marker on the day side
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(impact.lon, impact.lat, impact.h),
          point: new Cesium.PointGraphics({
            pixelSize: 12,
            color,
            outlineColor: Cesium.Color.WHITE.withAlpha(0.8),
            outlineWidth: 1.5,
          }),
          label: new Cesium.LabelGraphics({
            text: new Cesium.CallbackProperty(
              () => `CME ${cmeLabel(cme)}`,
              false,
            ),
            font: '11px system-ui, sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -14),
          }),
          description:
            `<b>CME ${escapeHtml(cme.id ?? '')}</b><br>` +
            `Speed: ${Number.isFinite(cme.speedKms) ? Math.round(cme.speedKms) + ' km/s' : '—'}<br>` +
            `ETA (ballistic model): ${escapeHtml(etaCountdown(cme.etaMs))}<br>` +
            (cme.note ? `${escapeHtml(cme.note)}<br>` : '') +
            `<span style="opacity:.75">Earth-directed = heuristic; ETA = constant-speed ` +
            `model, not a forecast.</span>`,
        });
      }
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[c]);
    }

    let statusEl = null;
    let flareEl = null;
    function updateStatus(cmes, flares) {
      if (statusEl) {
        const directed = cmes.filter((c) => c.earthDirected).length;
        statusEl.textContent = `${cmes.length} CMEs / ${directed} Earth-directed (30d)`;
      }
      if (flareEl) {
        const recent = flares
          .filter((f) => f.class)
          .sort((a, b) => (b.peakMs ?? 0) - (a.peakMs ?? 0))
          .slice(0, 3);
        flareEl.innerHTML = recent.length
          ? recent
              .map(
                (f) =>
                  `<div>☀️ ${escapeHtml(f.class)}-class flare` +
                  (f.sourceLocation ? ` @ ${escapeHtml(f.sourceLocation)}` : '') +
                  `</div>`,
              )
              .join('')
          : '<div style="opacity:.6">no classified flares in window</div>';
      }
    }

    function setEnabled(on) {
      enabled = on;
      ds.show = on;
      if (on) {
        void load();
        refreshTimer = setInterval(load, REFRESH_MS);
        tickTimer = setInterval(() => {
          // labels use CallbackProperty; nothing to do — kept for future pulse
        }, 60_000);
      } else {
        clearInterval(refreshTimer);
        clearInterval(tickTimer);
      }
    }

    if (mount && typeof chip === 'function') {
      try {
        statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'tracking CMEs…';
        mount.appendChild(statusEl);
        flareEl = document.createElement('div');
        flareEl.style.cssText =
          'font-size:10px;color:#c8d6f5;margin:2px 0;line-height:1.5;';
        mount.appendChild(flareEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('donki', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.donki') || 'Solar storms', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.donki') || 'Solar storms', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '<span style="color:#ffb454">●</span> &lt;500 km/s · ' +
          '<span style="color:#ff7a3d">●</span> 500–1000 · ' +
          '<span style="color:#ff5a5a">●</span> 1000–1500 · ' +
          '<span style="color:#c44dff">●</span> 1500+<br>' +
          '<span style="opacity:.75">Earth-directed = heuristic; ETA = ballistic ' +
          'constant-speed model, not a forecast. Source: NASA DONKI.</span>';
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
    console.warn('[wave3 donki] init failed:', error);
    return null;
  }
}
