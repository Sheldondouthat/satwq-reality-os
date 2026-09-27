/**
 * Wave 3 / Track 3b — Cumiana Schumann-resonance panel mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Renders /api/schumann as a dock panel: the two live Cumiana chart images
 * (proxied same-origin — the station is HTTP-only) with an explicit
 * image-derived label, plus a gesture-gated SYMBOLIC 7.83 Hz tone.
 *
 * The tone is a representational sound model (Web Audio oscillators at
 * 7.83 Hz and harmonics, user-started only). It is NOT the station's
 * signal and is labeled as such in the panel. It does not use the shared
 * sonification bus — that bus only supports quake/lightning/ISS methods.
 */
import * as Cesium from 'cesium';
import { escapeHtml } from './model.js';

const API = '/api/schumann';
const REFRESH_MS = 20 * 60_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let statusEl = null;
    let panelEl = null;
    let audioCtx = null;
    let audioNodes = null;
    let toneBtn = null;

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (destroyed || !enabled) return;
        render(json);
      } catch {
        if (statusEl) statusEl.textContent = 'schumann data unavailable — retrying';
      }
    }

    function stopTone() {
      try {
        audioNodes?.forEach((n) => { try { n.stop(); } catch {} });
        audioCtx?.close?.();
      } catch { /* noop */ }
      audioNodes = null;
      audioCtx = null;
      if (toneBtn) toneBtn.textContent = '▶ symbolic 7.83 Hz tone';
    }

    function toggleTone() {
      if (audioCtx) {
        stopTone();
        return;
      }
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
        const master = audioCtx.createGain();
        master.gain.value = 0.0001;
        master.connect(audioCtx.destination);
        // Representational: 7.83 Hz fundamental + first two Schumann-ish
        // harmonics at low gain. Explicitly symbolic, not measured audio.
        audioNodes = [7.83, 14.3, 20.8].map((f, i) => {
          const osc = audioCtx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = f;
          const g = audioCtx.createGain();
          g.gain.value = [1, 0.35, 0.18][i];
          osc.connect(g);
          g.connect(master);
          osc.start();
          return osc;
        });
        master.gain.linearRampToValueAtTime(0.12, audioCtx.currentTime + 3);
        if (toneBtn) toneBtn.textContent = '⏹ stop tone';
      } catch {
        stopTone();
      }
    }

    function render(doc) {
      if (!panelEl) return;
      if (statusEl) {
        statusEl.textContent =
          `${doc.charts.length} live chart${doc.charts.length === 1 ? '' : 's'}` +
          (doc.stale ? ' · stale' : '') + ' · vlf.it Cumiana';
      }
      panelEl.innerHTML = doc.charts
        .map(
          (c) =>
            `<div style="margin:4px 0">` +
            `<div style="font-size:10px;color:#c8d6f5">${escapeHtml(c.title)}</div>` +
            `<div style="font-size:9px;color:#5a6b8f">${escapeHtml(c.cadenceNote)}</div>` +
            `<img src="${escapeHtml(c.proxiedUrl)}" alt="${escapeHtml(c.title)} — live chart image" ` +
            `style="width:100%;border-radius:6px;border:1px solid #1b2a4d;margin-top:2px"></div>`,
        )
        .join('');
    }

    function setEnabled(on) {
      enabled = on;
      if (on) {
        void load();
        refreshTimer = setInterval(load, REFRESH_MS);
      } else {
        clearInterval(refreshTimer);
        stopTone();
      }
    }

    if (mount && typeof chip === 'function') {
      try {
        statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'tuning the cavity…';
        mount.appendChild(statusEl);
        panelEl = document.createElement('div');
        panelEl.style.cssText = 'max-height:480px;overflow:auto;';
        mount.appendChild(panelEl);
        toneBtn = document.createElement('button');
        toneBtn.textContent = '▶ symbolic 7.83 Hz tone';
        toneBtn.style.cssText =
          'font-size:10px;margin:4px 0;padding:3px 10px;border-radius:9px;' +
          'border:1px solid #2a3b66;background:transparent;color:#8aa4d6;cursor:pointer;';
        toneBtn.addEventListener('click', toggleTone);
        mount.appendChild(toneBtn);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('schumann', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.schumann') || 'Schumann resonance', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.schumann') || 'Schumann resonance', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          'Charts are <b>image-derived</b>, not numerical 7.83 Hz telemetry — ' +
          'no amplitudes are measured here. The tone is a <b>symbolic</b> sound ' +
          'model (user-started), not the station signal.';
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
    console.warn('[wave3 schumann] init failed:', error);
    return null;
  }
}
