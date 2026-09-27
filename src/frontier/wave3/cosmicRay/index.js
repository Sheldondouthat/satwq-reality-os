/**
 * Cosmic-ray weather (3.1) — Cesium view + fail-soft mount.
 *
 * Consumes W5's NMDB data layer (src/frontier/wave3/nmdb/source.js):
 * station nodes pulse with station-relative deviation; a coarse
 * Forbush-decrease watch banners in the panel. No global-field claims.
 */
import * as Cesium from 'cesium';
import { createNmdbSource } from '../nmdb/source.js';
import {
  coerceStation,
  stationPulse,
  detectForbush,
  globalMood,
  rankStations,
  formatMAD,
  isLive,
  COSMIC_HONESTY,
} from './model.js';

const REFRESH_NOTE_MS = 60000;

function cssColor(hex, alpha = 1) {
  return Cesium.Color.fromCssColorString(hex).withAlpha(alpha);
}

export function createCosmicRayLayer({ nmdbSource } = {}) {
  if (!nmdbSource || typeof nmdbSource.getSnapshot !== 'function')
    throw new TypeError('Cosmic-ray layer requires W5 nmdbSource');
  let viewer = null;
  let entityGroup = null;
  let enabled = false;
  let lastStations = [];
  let lastForbush = { level: 'quiet', drops: [], note: '' };
  let stopSource = null;

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

  function onSnapshot(snapshot) {
    const stations = [];
    for (const raw of snapshot?.stations ?? []) {
      const s = coerceStation(raw);
      if (s) stations.push(s);
    }
    lastStations = stations;
    lastForbush = detectForbush(stations);
    if (enabled) draw();
  }

  /** Tracked add: every child entity is registered for explicit removal. */
  function addKid(obj) {
    const e = viewer.entities.add(obj);
    kids.push(e);
    return e;
  }

  function draw() {
    clear();
    entityGroup = viewer.entities.add(new Cesium.Entity());
    for (const s of lastStations) {
      const pulse = stationPulse(s.deviationMAD);
      const alerted = lastForbush.drops.some((d) => d.code === s.code);
      const devText = isLive(s)
        ? `${formatMAD(s.deviationMAD)} vs 1-day median (MAD)`
        : 'no data';
      addKid({
        parent: entityGroup,
        position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 1000),
        point: {
          pixelSize: alerted
            ? new Cesium.CallbackProperty(
                // t is a JulianDate object, NOT a number — convert first.
                (t) => pulse.size + Math.round(4 * pulsePhase(Cesium.JulianDate.toDate(t).getTime())),
                false,
              )
            : pulse.size,
          color: cssColor(pulse.color, 0.95),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.4),
          outlineWidth: 1,
        },
        description: `${s.name} (${s.code}): ${devText}`,
      });
      if (isLive(s) && Math.abs(s.deviationMAD) >= 2) {
        addKid({
          parent: entityGroup,
          position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 30000),
          label: {
            text: `${s.code} ${formatMAD(s.deviationMAD)}`,
            font: '11px system-ui, sans-serif',
            fillColor: cssColor(pulse.color, 1),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -16),
          },
        });
      }
    }
  }

  return {
    id: 'cosmicRay',
    init(v) { viewer = v; },
    enable() {
      if (!viewer || enabled) return;
      enabled = true;
      stopSource = nmdbSource.start(onSnapshot);
      onSnapshot(nmdbSource.getSnapshot());
    },
    disable() {
      enabled = false;
      if (stopSource) { stopSource(); stopSource = null; }
      clear();
    },
    destroy() { this.disable(); viewer = null; },
    getStations: () => lastStations,
    getForbush: () => lastForbush,
    /** Test seam: feed a snapshot without the network. */
    ingest: onSnapshot,
  };
}

/** Dock panel: global mood, Forbush banner, station ranking. */
export function createCosmicRayPanel({ layer }) {
  const root = document.createElement('div');
  root.style.cssText = 'margin-top:6px;font-size:11px;color:#dfe9ff;';
  const render = () => {
    const stations = rankStations(layer.getStations());
    const forbush = layer.getForbush();
    const mood = globalMood(layer.getStations());
    root.innerHTML = '';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;letter-spacing:.06em;margin-bottom:4px;';
    title.textContent = stations.length
      ? `◉ Cosmic rays — ${mood.label}${mood.median !== null ? ` (${formatMAD(mood.median)} median)` : ''}`
      : '◉ Cosmic rays — waiting on /api/nmdb';
    root.appendChild(title);
    if (forbush.level !== 'quiet') {
      const banner = document.createElement('div');
      banner.style.cssText = `font-weight:700;margin:2px 0;color:${forbush.level === 'alert' ? '#ff3b3b' : '#ff9f5a'};`;
      banner.textContent = forbush.level === 'alert'
        ? `⚠ FORBUSH WATCH: ${forbush.drops.length} stations ≤ −3σ (max ${formatMAD(forbush.maxDropMAD)})`
        : `⚠ Forbush watch: ${forbush.drops.length} stations ≤ −3σ`;
      root.appendChild(banner);
    }
    for (const s of stations.slice(0, 8)) {
      const pulse = stationPulse(s.deviationMAD);
      const row = document.createElement('div');
      row.style.cssText = `padding:1px 0;color:${pulse.color};`;
      row.textContent = `${s.name} (${s.code}) ${formatMAD(s.deviationMAD)}`;
      root.appendChild(row);
    }
    const note = document.createElement('div');
    note.style.cssText = 'opacity:.55;margin-top:4px;font-size:10px;color:#dfe9ff;';
    note.textContent = COSMIC_HONESTY;
    root.appendChild(note);
  };
  const timer = setInterval(render, REFRESH_NOTE_MS);
  render();
  return { element: root, sync: render, destroy() { clearInterval(timer); root.remove(); } };
}

/**
 * Fail-soft mount for initFrontier. Never throws; returns a cleanup fn.
 * Wires W5's NMDB data layer under this feature's own refresh cadence.
 */
export function initCosmicRay({ viewer, refreshMs } = {}) {
  try {
    if (!viewer) return () => {};
    const nmdbSource = createNmdbSource({ refreshMs });
    const layer = createCosmicRayLayer({ nmdbSource });
    layer.init(viewer);
    layer.enable();
    return () => layer.destroy();
  } catch (error) {
    console.warn('[frontier] cosmicRay failed:', error);
    return () => {};
  }
}

/** Generic fail-soft entry point required by the Wave 3 mount contract. */
export { initCosmicRay as init };
