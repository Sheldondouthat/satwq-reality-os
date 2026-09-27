/**
 * Wave 3 / Track 3b.8 — Volcano infrasound mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Pins AV-network infrasound (BDF) stations on the globe, colored by the
 * current 10-minute RMS pressure from /api/infrasound. Clicking a pin opens
 * a dock panel with the pressure envelope, RMS/peak values, and an
 * "audify" button.
 *
 * Physics honesty (shown in the legend + panel):
 *  - RMS/peak Pa are REAL measured pressure from EarthScope FDSN BDF
 *    channels, converted counts→Pa via each channel's SEED scale factor.
 *  - Volcano names are INFERRED from AVO station prefixes; coordinates are
 *    authoritative FDSN metadata.
 *  - "Audify" is an envelope audification MODEL: a sub-audio rumble whose
 *    loudness follows the measured 10-min envelope — it is NOT the raw
 *    infrasound waveform (which is below human hearing anyway).
 */
import * as Cesium from 'cesium';
import { audifyEnvelope, envelopeSparkline, fmtPa } from './model.js';

const API = '/api/infrasound';
const REFRESH_MS = 5 * 60_000;

const PRESSURE_COLORS = {
  loud: '#ff5a5a',
  elevated: '#ff9f43',
  active: '#ffd166',
  quiet: '#4dd0a6',
  unknown: '#8aa4d6',
  no_data: '#55607a',
  no_station: '#55607a',
  error: '#55607a',
  decode_error: '#55607a',
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/* fmtPa, envelopeSparkline, audifyEnvelope live in ./model.js (node-testable). */

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave3-infrasound');
    ds.show = false;
    viewer.dataSources.add(ds);

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let statusEl = null;
    let panelEl = null;
    let lastData = null;

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (destroyed || !enabled) return;
        lastData = json;
        render(json.stations ?? []);
        updateStatus(json);
      } catch {
        if (statusEl) statusEl.textContent = 'infrasound unavailable — retrying';
      }
    }

    function render(stations) {
      ds.entities.removeAll();
      for (const s of stations) {
        if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
        const color = PRESSURE_COLORS[s.pressure ?? s.state] ?? '#8aa4d6';
        const rms = fmtPa(s.rmsPa);
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 120_000),
          point: new Cesium.PointGraphics({
            pixelSize: s.pressure === 'loud' ? 14 : 10,
            color: Cesium.Color.fromCssColorString(color),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
            outlineWidth: 1.5,
          }),
          label: new Cesium.LabelGraphics({
            text: `${s.net}.${s.sta}`,
            font: '10px system-ui, sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -12),
          }),
          description:
            `<b>${escapeHtml(s.net)}.${escapeHtml(s.sta)} — infrasound</b><br>` +
            (s.volcanoHint ? `${escapeHtml(s.volcanoHint)}<br>` : '') +
            `RMS: ${escapeHtml(rms)} · Peak: ${escapeHtml(fmtPa(s.peakPa))}<br>` +
            `State: ${escapeHtml(s.pressure ?? s.state)}<br>` +
            `<span style="opacity:.75">Real measured pressure (EarthScope FDSN). ` +
            `Volcano name is inferred from the station prefix.</span>`,
        });
      }
    }

    function updateStatus(json) {
      if (!statusEl) return;
      const live = (json.stations ?? []).filter((s) => s.state === 'live');
      const hot = live.filter((s) => s.pressure === 'loud' || s.pressure === 'elevated');
      statusEl.textContent =
        live.length === 0
          ? 'no live infrasound stations'
          : `${live.length} live · ${hot.length} elevated/loud`;
    }

    function showPanel() {
      if (!panelEl) return;
      const stations = lastData?.stations ?? [];
      panelEl.innerHTML = stations.length
        ? stations
            .map((s) => {
              const color = PRESSURE_COLORS[s.pressure ?? s.state] ?? '#8aa4d6';
              return (
                `<div style="margin:6px 0;padding:6px;border-left:3px solid ${color};` +
                `background:#0e1830;border-radius:4px">` +
                `<div><b>${escapeHtml(s.net)}.${escapeHtml(s.sta)}</b> ` +
                `<span style="opacity:.7">${escapeHtml(s.pressure ?? s.state)}</span></div>` +
                (s.volcanoHint
                  ? `<div style="opacity:.7;font-size:10px">${escapeHtml(s.volcanoHint)}</div>`
                  : '') +
                `<div style="font-size:10px">RMS ${escapeHtml(fmtPa(s.rmsPa))} · ` +
                `Peak ${escapeHtml(fmtPa(s.peakPa))}</div>` +
                (s.envelopePa ? envelopeSparkline(s.envelopePa, color) : '') +
                (s.state === 'live'
                  ? `<button data-audify="${escapeHtml(s.sta)}" ` +
                    `style="margin-top:4px;font-size:10px;cursor:pointer">` +
                    `🔊 Audify envelope (model)</button>`
                  : '') +
                `</div>`
              );
            })
            .join('')
        : '<div style="opacity:.6">no station data yet</div>';
      panelEl.querySelectorAll('button[data-audify]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const sta = btn.getAttribute('data-audify');
          const s = (lastData?.stations ?? []).find((x) => x.sta === sta);
          const ok = audifyEnvelope(s?.envelopePa, { lon: s?.lon ?? 0 });
          btn.textContent = ok ? '🔊 playing (model)…' : '🔇 audio unavailable';
          setTimeout(() => {
            btn.textContent = '🔊 Audify envelope (model)';
          }, 8500);
        });
      });
    }

    function setEnabled(on) {
      enabled = on;
      ds.show = on;
      if (on) {
        void load().then(showPanel);
        refreshTimer = setInterval(() => {
          void load().then(showPanel);
        }, REFRESH_MS);
      } else {
        clearInterval(refreshTimer);
      }
    }

    if (mount && typeof chip === 'function') {
      try {
        statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'listening for eruptions…';
        mount.appendChild(statusEl);
        panelEl = document.createElement('div');
        panelEl.style.cssText = 'font-size:11px;color:#c8d6f5;max-height:320px;overflow:auto;';
        mount.appendChild(panelEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('infrasound', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.infrasound') || 'Volcano infrasound', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.infrasound') || 'Volcano infrasound', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '<span style="color:#4dd0a6">●</span> quiet · ' +
          '<span style="color:#ffd166">●</span> active · ' +
          '<span style="color:#ff9f43">●</span> elevated · ' +
          '<span style="color:#ff5a5a">●</span> loud<br>' +
          '<span style="opacity:.75">Measured pressure via EarthScope FDSN (BDF ' +
          'channels). Volcano names are inferred from station prefixes. ' +
          'Audify = envelope model, not raw audio.</span>';
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
    console.warn('[wave3 infrasound] init failed:', error);
    return null;
  }
}
