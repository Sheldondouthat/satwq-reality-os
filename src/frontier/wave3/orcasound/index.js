/**
 * Wave 3 / Track 3b — Orcasound hydrophones mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Renders /api/orcasound as a dock panel: hydrophone list with online state,
 * click-to-play live HLS audio (hls.js lazy-loaded, same pattern as
 * src/layers/cctv/videoPlayback.js). Globe behavior: clicking a hydrophone
 * row flies the camera to its coordinates; a separate play button starts
 * audio (user gesture, so no autoplay issues).
 *
 * Honesty: the audio is the live hydrophone stream, unmodified. This panel
 * performs no orca-call detection and makes no claims about what is heard.
 */
import * as Cesium from 'cesium';
import { escapeHtml, fmtCoords } from './model.js';

const API = '/api/orcasound';
const REFRESH_MS = 60_000;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let statusEl = null;
    let panelEl = null;
    let audioEl = null;
    let hls = null;
    let playingNode = null;
    let playBtns = [];

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (destroyed || !enabled) return;
        render(json);
      } catch {
        if (statusEl) statusEl.textContent = 'hydrophones unavailable — retrying';
      }
    }

    function stopAudio() {
      try {
        hls?.destroy();
        hls = null;
        if (audioEl) {
          audioEl.pause();
          audioEl.removeAttribute('src');
          audioEl.load();
        }
      } catch { /* noop */ }
      playingNode = null;
      for (const b of playBtns) b.textContent = '▶ listen';
    }

    async function playFeed(feed, btn) {
      if (playingNode === feed.nodeName) {
        stopAudio();
        return;
      }
      stopAudio();
      if (!feed.hlsUrl) return;
      try {
        btn.textContent = '…';
        const { default: Hls } = await import('hls.js');
        if (destroyed || !enabled) return;
        if (Hls.isSupported()) {
          hls = new Hls({ maxBufferLength: 30 });
          hls.loadSource(feed.hlsUrl);
          hls.attachMedia(audioEl);
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (data?.fatal) {
              btn.textContent = '⚠ error';
              stopAudio();
            }
          });
        } else if (audioEl.canPlayType('application/vnd.apple.mpegurl')) {
          audioEl.src = feed.hlsUrl; // Safari native HLS
        } else {
          btn.textContent = '⚠ unsupported';
          return;
        }
        await audioEl.play();
        playingNode = feed.nodeName;
        btn.textContent = '⏹ stop';
      } catch {
        btn.textContent = '⚠ error';
        stopAudio();
      }
    }

    function flyTo(feed) {
      try {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(feed.lon, feed.lat, 50000),
          duration: 2,
        });
      } catch { /* camera gesture optional */ }
    }

    function render(doc) {
      if (!panelEl) return;
      const list = doc.hydrophones ?? [];
      if (statusEl) {
        statusEl.textContent =
          `${doc.onlineCount}/${doc.count} hydrophones online` +
          (doc.stale ? ' · stale' : '');
      }
      playBtns = [];
      panelEl.innerHTML = '';
      for (const f of list) {
        const row = document.createElement('div');
        row.style.cssText =
          'display:flex;align-items:center;gap:6px;font-size:10px;color:#c8d6f5;margin:3px 0;';
        const dot = `<span style="color:${f.online ? '#4dd0a6' : '#55607a'}">${
          f.online ? '●' : '○'}</span>`;
        const info =
          `<span style="flex:1;cursor:pointer" data-fly="1" title="fly camera here">` +
          `<b>${escapeHtml(f.name)}</b><br>` +
          `<span style="color:#8aa4d6">${escapeHtml(fmtCoords(f.lat, f.lon))}</span></span>`;
        row.innerHTML = dot + info;
        const fly = row.querySelector('[data-fly]');
        if (fly) fly.addEventListener('click', () => flyTo(f));
        if (f.online && f.hlsUrl) {
          const btn = document.createElement('button');
          btn.textContent = playingNode === f.nodeName ? '⏹ stop' : '▶ listen';
          btn.style.cssText =
            'font-size:10px;padding:2px 8px;border-radius:9px;border:1px solid #2a3b66;' +
            'background:transparent;color:#8aa4d6;cursor:pointer;white-space:nowrap;';
          btn.addEventListener('click', () => playFeed(f, btn));
          row.appendChild(btn);
          playBtns.push(btn);
        }
        panelEl.appendChild(row);
      }
    }

    function setEnabled(on) {
      enabled = on;
      if (on) {
        void load();
        refreshTimer = setInterval(load, REFRESH_MS);
      } else {
        clearInterval(refreshTimer);
        stopAudio();
      }
    }

    if (mount && typeof chip === 'function') {
      try {
        statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'listening for whales…';
        mount.appendChild(statusEl);
        panelEl = document.createElement('div');
        panelEl.style.cssText = 'max-height:340px;overflow:auto;';
        mount.appendChild(panelEl);
        audioEl = document.createElement('audio');
        audioEl.preload = 'none';
        audioEl.style.display = 'none';
        mount.appendChild(audioEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('orcasound', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.orcasound') || 'Hydrophones', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.orcasound') || 'Hydrophones', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          'Live hydrophone audio, unmodified. <b>No call detection</b> — ' +
          'what you hear is what the ocean says. Click a name to fly there.';
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
    console.warn('[wave3 orcasound] init failed:', error);
    return null;
  }
}
