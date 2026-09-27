/**
 * Wave 3 / Track 3b — eclipse geometry engine mount.
 *
 * Fail-soft `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Renders /api/eclipse?event=2045 as Cesium entities:
 *   - red centerline polyline across the whole event
 *   - umbral shadow ellipse that follows a rehearsal time scrubber
 *   - golden-hour and blue-hour ring bands around the subsolar point
 *     at the scrubbed time
 *   - play button animating the shadow from US landfall to exit
 *
 * All geometry is computed from NASA-published Besselian elements
 * (see model.js); the panel labels it a rehearsal model.
 */
import * as Cesium from 'cesium';
import {
  LIGHT_BANDS,
  ringAroundPoint,
  ringRadiusForElevation,
  subsolarPointAt,
  utcToTdtHours,
  ECLIPSE_2045,
} from './model.js';

const API = '/api/eclipse?event=2045&stepMin=2';

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;

    let enabled = false;
    let destroyed = false;
    let statusEl = null;
    let panelEl = null;
    let samples = [];
    let usPassage = null;
    let entities = [];
    let playTimer = 0;
    let scrub = null;
    let scrubLabel = null;

    function clearEntities() {
      for (const e of entities) {
        try { viewer.entities.remove(e); } catch { /* noop */ }
      }
      entities = [];
    }

    function addEntity(def) {
      try {
        entities.push(viewer.entities.add(def));
      } catch { /* entity optional */ }
    }

    function ellipseAt(s) {
      if (!s || s.widthKm === null) return;
      addEntity({
        position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
        ellipse: {
          semiMinorAxis: (s.widthKm / 2) * 1000,
          semiMajorAxis: s.semiMajorKm * 1000,
          rotation: Cesium.Math.toRadians(s.majorAxisBearingDeg),
          material: Cesium.Color.BLACK.withAlpha(0.55),
          outline: true,
          outlineColor: Cesium.Color.RED.withAlpha(0.9),
        },
      });
    }

    function lightBandsAt(tHours) {
      const sub = subsolarPointAt(ECLIPSE_2045, tHours);
      for (const band of LIGHT_BANDS) {
        const outer = ringAroundPoint(sub.latDeg, sub.lonDeg,
          ringRadiusForElevation(band.elevLo), 96);
        const inner = ringAroundPoint(sub.latDeg, sub.lonDeg,
          ringRadiusForElevation(band.elevHi), 96);
        addEntity({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(outer.flat()),
              [new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(inner.flat()))],
            ),
            material: Cesium.Color.fromCssColorString(band.color).withAlpha(0.10),
            outline: false,
          },
        });
      }
    }

    function sampleAt(utcMs) {
      let best = samples[0];
      for (const s of samples) {
        if (Math.abs(new Date(s.utc).getTime() - utcMs) <
            Math.abs(new Date(best.utc).getTime() - utcMs)) best = s;
      }
      return best;
    }

    function renderAt(utcMs) {
      clearEntities();
      // Centerline (whole event).
      addEntity({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(
            samples.flatMap((s) => [s.lon, s.lat]),
          ),
          width: 2,
          material: Cesium.Color.RED.withAlpha(0.85),
        },
      });
      const s = sampleAt(utcMs);
      if (!s) return;
      // Shadow ellipse at the scrubbed time.
      const tHours = utcToTdtHours(ECLIPSE_2045, new Date(s.utc).getTime());
      ellipseAt(s);
      lightBandsAt(tHours);
      if (scrubLabel) {
        scrubLabel.textContent =
          `${s.utc.replace('T', ' ').slice(0, 19)}Z · ` +
          (s.widthKm !== null
            ? `width ${s.widthKm} km · totality ${s.durationSec ?? '—'}s`
            : 'penumbra only');
      }
    }

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(API);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc = await res.json();
        if (destroyed || !enabled) return;
        samples = doc.samples ?? [];
        usPassage = doc.usPassage;
        if (statusEl) {
          statusEl.textContent =
            `${doc.name} · ${samples.length} samples` +
            (usPassage ? ` · US ${usPassage.firstUtc.slice(11, 16)}–${usPassage.lastUtc.slice(11, 16)}Z` : '');
        }
        if (scrub && usPassage) {
          scrub.min = String(new Date(usPassage.firstUtc).getTime());
          scrub.max = String(new Date(usPassage.lastUtc).getTime());
          scrub.value = scrub.min;
          renderAt(Number(scrub.value));
        }
      } catch {
        if (statusEl) statusEl.textContent = 'eclipse data unavailable — retrying';
      }
    }

    function stopPlay() {
      clearInterval(playTimer);
      playTimer = 0;
    }

    function togglePlay(btn) {
      if (playTimer) {
        stopPlay();
        btn.textContent = '▶ rehearse US passage';
        return;
      }
      if (!usPassage || !scrub) return;
      btn.textContent = '⏹ stop';
      const start = Number(scrub.min);
      const end = Number(scrub.max);
      const span = end - start;
      const t0 = Date.now();
      const durMs = 30000; // 30 s for the whole US passage
      playTimer = setInterval(() => {
        const k = (Date.now() - t0) / durMs;
        if (k >= 1) {
          stopPlay();
          btn.textContent = '▶ rehearse US passage';
          return;
        }
        const v = start + span * k;
        scrub.value = String(v);
        renderAt(v);
      }, 100);
    }

    function setEnabled(on) {
      enabled = on;
      if (on) {
        void load();
      } else {
        stopPlay();
        clearEntities();
      }
    }

    if (mount && typeof chip === 'function') {
      try {
        statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'computing shadow…';
        mount.appendChild(statusEl);
        panelEl = document.createElement('div');
        mount.appendChild(panelEl);

        scrubLabel = document.createElement('div');
        scrubLabel.style.cssText = 'font-size:10px;color:#c8d6f5;margin:4px 0;';
        scrubLabel.textContent = '—';
        panelEl.appendChild(scrubLabel);

        scrub = document.createElement('input');
        scrub.type = 'range';
        scrub.style.cssText = 'width:100%;';
        scrub.addEventListener('input', () => {
          stopPlay();
          const btn = panelEl.querySelector('[data-play]');
          if (btn) btn.textContent = '▶ rehearse US passage';
          renderAt(Number(scrub.value));
        });
        panelEl.appendChild(scrub);

        const playBtn = document.createElement('button');
        playBtn.setAttribute('data-play', '1');
        playBtn.textContent = '▶ rehearse US passage';
        playBtn.style.cssText =
          'font-size:10px;margin:4px 0;padding:3px 10px;border-radius:9px;' +
          'border:1px solid #2a3b66;background:transparent;color:#8aa4d6;cursor:pointer;';
        playBtn.addEventListener('click', () => togglePlay(playBtn));
        panelEl.appendChild(playBtn);

        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('eclipse', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.eclipse') || 'Eclipse 2045', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.eclipse') || 'Eclipse 2045', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          'Shadow geometry from <b>NASA Besselian elements</b> (Espenak/GSFC) — ' +
          'a <b>rehearsal model</b>, not an official prediction. ' +
          'Gold/blue bands mark solar elevation at the scrubbed time.';
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
    console.warn('[wave3 eclipse] init failed:', error);
    return null;
  }
}
