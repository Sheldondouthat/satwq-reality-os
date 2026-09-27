/**
 * Wave 3 / Track 2a.1 — NWIS gauge layer mount.
 *
 * Fail-soft: any failure returns null and logs; the host app is never
 * broken. Exports `init({ viewer, mount, chip, trackLayer, t })`.
 *
 * Renders pulsing river dots colored by per-gauge trailing-window flow
 * anomaly (z-score vs the gauge's own recent history — NOT flood stage;
 * the legend says so). Dot size scales with discharge magnitude (log).
 * Refreshes on camera move (debounced) so the provider's bbox query
 * follows the view; small views get a real anomaly window, the whole
 * globe gets latest-only magnitudes.
 */
import * as Cesium from 'cesium';
import {
  anomalyColor,
  basePixelSize,
  gaugeLabel,
  pulsePeriodMs,
} from './model.js';

const API = '/api/nwis-gauges';
const DEFAULT_BBOX = '-125,24,-66,50';
const REFRESH_MS = 15 * 60_000;
const PULSE_MS = 240;

function viewBbox(viewer) {
  try {
    const rect = viewer.camera.computeViewRectangle();
    if (!rect) return null;
    const d = Cesium.Math.toDegrees;
    const w = d(rect.west);
    const s = d(rect.south);
    const e = d(rect.east);
    const n = d(rect.north);
    if (![w, s, e, n].every(Number.isFinite)) return null;
    if (e - w <= 0 || n - s <= 0) return null;
    return `${w.toFixed(2)},${s.toFixed(2)},${e.toFixed(2)},${n.toFixed(2)}`;
  } catch {
    return null;
  }
}

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave3-nwis-gauges');
    ds.show = false;
    viewer.dataSources.add(ds);

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let pulseTimer = 0;
    let moveTimer = 0;
    let lastBbox = '';
    const phases = new Map(); // entity id -> phase radians

    async function load(bbox) {
      if (destroyed || !enabled) return;
      try {
        const res = await fetch(`${API}?bbox=${encodeURIComponent(bbox)}`);
        if (!res.ok) return;
        const doc = await res.json();
        if (destroyed || !enabled) return;
        render(doc.gauges ?? []);
        updateStatus(doc);
      } catch {
        /* fail-soft: keep last good render */
      }
    }

    function render(gauges) {
      ds.entities.removeAll();
      phases.clear();
      for (const g of gauges.slice(0, 500)) {
        if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
        const color = Cesium.Color.fromCssColorString(anomalyColor(g.flowZ));
        const entity = ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(g.lon, g.lat, 500),
          point: new Cesium.PointGraphics({
            pixelSize: basePixelSize(g),
            color,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          }),
          description: gaugeLabel(g),
        });
        phases.set(entity.id, Math.random() * Math.PI * 2);
        entity._nwisPeriod = pulsePeriodMs(g.flowZ);
        entity._nwisBase = basePixelSize(g);
      }
    }

    function pulse() {
      if (!enabled || destroyed) return;
      const now = Date.now();
      for (const entity of ds.entities.values) {
        const period = entity._nwisPeriod ?? 2000;
        const base = entity._nwisBase ?? 6;
        const phase = phases.get(entity.id) ?? 0;
        const k = 1 + 0.38 * Math.sin((2 * Math.PI * now) / period + phase);
        try {
          entity.point.pixelSize = base * k;
        } catch {
          /* entity removed mid-pulse */
        }
      }
    }

    function requestBbox() {
      const bbox = viewBbox(viewer) ?? DEFAULT_BBOX;
      if (bbox === lastBbox) return;
      lastBbox = bbox;
      void load(bbox);
    }

    const onMoveEnd = () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(requestBbox, 900);
    };

    function setEnabled(on) {
      enabled = on;
      ds.show = on;
      if (on) {
        requestBbox();
        refreshTimer = setInterval(requestBbox, REFRESH_MS);
        pulseTimer = setInterval(pulse, PULSE_MS);
        viewer.camera.moveEnd.addEventListener(onMoveEnd);
      } else {
        clearInterval(refreshTimer);
        clearInterval(pulseTimer);
        viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      }
    }

    let statusEl = null;
    function updateStatus(doc) {
      if (!statusEl) return;
      const basis = doc.anomalyBasis ?? '';
      statusEl.textContent =
        `${doc.count ?? 0} gauges` +
        (doc.stale ? ' · stale' : '') +
        (basis ? ` · ${basis}` : '');
    }

    // — dock UI —
    if (mount && typeof chip === 'function') {
      try {
        statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'loading gauges…';
        mount.appendChild(statusEl);
        const ctl = { show: () => setEnabled(true), hide: () => setEnabled(false) };
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('nwisGauges', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.nwisGauges') || 'River gauges', (on) =>
              on ? tracked.show() : tracked.hide(),
            false),
          );
        } else {
          mount.appendChild(
            chip(T('feature.nwisGauges') || 'River gauges', (on) => setEnabled(on), false),
          );
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.5;';
        legend.innerHTML =
          '<span style="color:#2563eb">●</span> low vs own history · ' +
          '<span style="color:#cbd5e1">●</span> normal · ' +
          '<span style="color:#ef4444">●</span> high vs own history<br>' +
          '<span style="opacity:.75">Anomaly = trailing-window z-score per gauge, ' +
          'not flood stage. Size = discharge (log).</span>';
        mount.appendChild(legend);
      } catch {
        /* dock UI is optional */
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
    console.warn('[wave3 nwisGauges] init failed:', error);
    return null;
  }
}
