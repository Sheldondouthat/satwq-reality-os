/**
 * Wave 3 / Track 3b — TESS transit alerts mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Renders /api/transits as a dock panel: upcoming TOI mid-transits sorted
 * soonest-first, with countdown, period, magnitude, and disposition.
 * Globe behavior: clicking a row flies the viewer to the target's sky
 * coordinates (ra/dec) — a camera move only, no celestial rendering claims.
 * Every time is labeled a Kepler prediction; PC/CP are labeled candidates.
 */
import * as Cesium from 'cesium';
import { countdown, dispositionLabel, escapeHtml } from './model.js';

const API = '/api/transits';
const REFRESH_MS = 15 * 60_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let statusEl = null;
    let panelEl = null;

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(`${API}?days=14&limit=25`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (destroyed || !enabled) return;
        render(json);
      } catch {
        if (statusEl) statusEl.textContent = 'transit data unavailable — retrying';
      }
    }

    function flyTo(raDeg, decDeg) {
      try {
        // Camera gesture toward the target's equatorial coordinates.
        const dir = new Cesium.Cartesian3(
          Math.cos(Cesium.Math.toRadians(decDeg)) * Math.cos(Cesium.Math.toRadians(raDeg)),
          Math.cos(Cesium.Math.toRadians(decDeg)) * Math.sin(Cesium.Math.toRadians(raDeg)),
          Math.sin(Cesium.Math.toRadians(decDeg)),
        );
        viewer.camera.lookAtTransform(
          Cesium.Matrix4.IDENTITY,
          dir.multiplyByScalar(3 * Cesium.Ellipsoid.WGS84.maximumRadius),
        );
      } catch {
        /* camera gesture optional */
      }
    }

    function render(doc) {
      const list = doc.transits ?? [];
      if (statusEl) {
        statusEl.textContent =
          list.length === 0 ? 'no transits in window'
            : `${list.length} upcoming · next ${countdown(list[0].hoursUntil)}`;
      }
      if (!panelEl) return;
      panelEl.innerHTML = list
        .map((tr) => {
          const cd = countdown(tr.hoursUntil);
          return (
            `<div style="font-size:10px;color:#c8d6f5;margin:3px 0;cursor:pointer" ` +
            `data-ra="${escapeHtml(tr.raDeg)}" data-dec="${escapeHtml(tr.decDeg)}" ` +
            `title="fly camera toward target">` +
            `<b>TOI ${escapeHtml(tr.toi)}</b> ` +
            `<span style="color:#4dd0a6">${escapeHtml(cd)}</span><br>` +
            `<span style="color:#8aa4d6">${escapeHtml((tr.nextTransitUtc ?? '').replace('T', ' ').slice(0, 16))}Z · ` +
            `P ${escapeHtml(tr.periodDays)}d · mag ${escapeHtml(tr.tmag)} · ` +
            `${escapeHtml(dispositionLabel(tr.disposition))}</span></div>`
          );
        })
        .join('');
      for (const el of panelEl.querySelectorAll('[data-ra]')) {
        el.addEventListener('click', () => {
          const ra = Number(el.getAttribute('data-ra'));
          const dec = Number(el.getAttribute('data-dec'));
          if (Number.isFinite(ra) && Number.isFinite(dec)) flyTo(ra, dec);
        });
      }
    }

    function setEnabled(on) {
      enabled = on;
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
        statusEl.textContent = 'computing transits…';
        mount.appendChild(statusEl);
        panelEl = document.createElement('div');
        panelEl.style.cssText = 'max-height:340px;overflow:auto;';
        mount.appendChild(panelEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('tess', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.tess') || 'Exoplanet transits', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.tess') || 'Exoplanet transits', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          'Times are <b>Kepler predictions</b> (epoch + n·period) from NASA ' +
          'Exoplanet Archive TOIs, approximate to a few minutes. PC/CP are ' +
          'candidates, not confirmed planets. Click a row to point the camera.';
        mount.appendChild(legend);
      } catch {
        /* dock UI optional */
      }
    }

    return function destroy() {
      destroyed = true;
      setEnabled(false);
    };
  } catch (error) {
    console.warn('[wave3 tess] init failed:', error);
    return null;
  }
}
