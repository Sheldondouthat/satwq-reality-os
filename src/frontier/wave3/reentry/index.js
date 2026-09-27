/**
 * TLE decay prediction (3.4) — Cesium view + fail-soft mount.
 *
 * Final-orbit ground tracks with uncertainty bands (nominal bright,
 * early/late window tracks dim), urgency-colored. Land-overflight alerts in
 * the panel are heuristic and labeled as such.
 */
import * as Cesium from 'cesium';
import {
  groundTrack,
  uncertaintyBand,
  overflightAlert,
  formatTiming,
  rankCandidates,
  URGENCY_STYLE,
  REENTRY_HONESTY,
} from './model.js';
import { createReentrySource } from './source.js';

const MAX_TRACKS = 10;
const REFRESH_MS = 6 * 3600_000;

function cssColor(hex, alpha = 1) {
  return Cesium.Color.fromCssColorString(hex).withAlpha(alpha);
}

export function createReentryLayer({ source } = {}) {
  if (typeof source?.getReentries !== 'function')
    throw new TypeError('Reentry layer requires a source');
  let viewer = null;
  let entityGroup = null;
  let timer = null;
  let enabled = false;
  let lastCandidates = [];
  let lastAlerts = new Map(); // id -> overflightAlert

  // Cesium's EntityCollection.remove does NOT cascade to children
  // (verified in the bundled build: removeById removes a single id),
  // so every child entity is tracked and removed explicitly.
  let kids = [];

  function clear() {
    if (viewer) {
      for (const kid of kids) viewer.entities.remove(kid);
      kids = [];
      if (entityGroup) {
        viewer.entities.remove(entityGroup);
        entityGroup = null;
      }
    }
  }

  function addTrack(points, color, width, alpha) {
    if (points.length < 2) return;
    addKid({
      parent: entityGroup,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(points.flat()),
        width,
        material: color.withAlpha(alpha),
      },
    });
  }

  /** Tracked add: every child entity is registered for explicit removal. */
  function addKid(obj) {
    const e = viewer.entities.add(obj);
    kids.push(e);
    return e;
  }

  function draw(candidates) {
    clear();
    entityGroup = viewer.entities.add(new Cesium.Entity());
    lastAlerts = new Map();
    const tracked = candidates.filter((c) => c.tle).slice(0, MAX_TRACKS);
    for (const c of rankCandidates(tracked)) {
      const style = URGENCY_STYLE[c.urg] ?? URGENCY_STYLE.nominal;
      const band = uncertaintyBand(c);
      if (!band || !band.nominal.length) continue;
      addTrack(band.early, cssColor(style.color), 1, 0.25);
      addTrack(band.late, cssColor(style.color), 1, 0.25);
      addTrack(band.nominal, cssColor(style.color), 2, 0.9);
      lastAlerts.set(c.id, overflightAlert(band.nominal));
      const tca = band.nominal[band.nominal.length - 1];
      addKid({
        parent: entityGroup,
        position: Cesium.Cartesian3.fromDegrees(tca[0], tca[1], 1000),
        point: {
          pixelSize: 12,
          color: cssColor(style.color, 0.95),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.5),
          outlineWidth: 1,
        },
      });
      addKid({
        parent: entityGroup,
        position: Cesium.Cartesian3.fromDegrees(tca[0], tca[1], 60000),
        label: {
          text: `${c.name}\n${formatTiming(c)}\n${style.label}`,
          font: '11px system-ui, sans-serif',
          fillColor: cssColor(style.color, 1),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -20),
        },
      });
    }
  }

  async function refresh() {
    try {
      const snap = await source.getReentries({ max: 25 });
      lastCandidates = snap.candidates;
      if (enabled) draw(lastCandidates);
      return { ok: true, count: lastCandidates.length };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  return {
    id: 'reentry',
    init(v) { viewer = v; },
    enable() {
      if (!viewer || enabled) return;
      enabled = true;
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
    },
    disable() {
      enabled = false;
      if (timer) { clearInterval(timer); timer = null; }
      clear();
    },
    destroy() { this.disable(); viewer = null; },
    getCandidates: () => lastCandidates,
    getAlerts: () => lastAlerts,
    refresh,
  };
}

/** Dock panel: modeled reentries with land-overflight alerts. */
export function createReentryPanel({ layer }) {
  const root = document.createElement('div');
  root.style.cssText = 'margin-top:6px;font-size:11px;color:#dfe9ff;';
  const render = () => {
    const candidates = rankCandidates(layer.getCandidates()).slice(0, 8);
    const alerts = layer.getAlerts();
    root.innerHTML = '';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;letter-spacing:.06em;margin-bottom:4px;';
    title.textContent = candidates.length ? `🛰 ${layer.getCandidates().length} modeled reentries` : '🛰 reentries — waiting on /api/reentries';
    root.appendChild(title);
    for (const c of candidates) {
      const style = URGENCY_STYLE[c.urg] ?? URGENCY_STYLE.nominal;
      const alert = alerts.get(c.id);
      const row = document.createElement('div');
      row.style.cssText = `padding:1px 0;color:${style.color};`;
      const landNote = alert?.crossesLand ? ' · ⚠ land overflight (heuristic)' : '';
      row.textContent = `${style.label} ${c.name} · ${formatTiming(c)}${landNote}`;
      root.appendChild(row);
    }
    const note = document.createElement('div');
    note.style.cssText = 'opacity:.55;margin-top:4px;font-size:10px;color:#dfe9ff;';
    note.textContent = REENTRY_HONESTY;
    root.appendChild(note);
  };
  const timer = setInterval(render, 60000);
  render();
  return { element: root, sync: render, destroy() { clearInterval(timer); root.remove(); } };
}

/** Fail-soft mount for initFrontier. Never throws; returns a cleanup fn. */
export function initReentries({ viewer } = {}) {
  try {
    if (!viewer) return () => {};
    const layer = createReentryLayer({ source: createReentrySource({}) });
    layer.init(viewer);
    layer.enable();
    return () => layer.destroy();
  } catch (error) {
    console.warn('[frontier] reentry failed:', error);
    return () => {};
  }
}

/** Generic fail-soft entry point required by the Wave 3 mount contract. */
export { initReentries as init };
