/**
 * Fireball impacts (3.2) — Cesium view + fail-soft mount.
 *
 * Archive fireballs as energy-scaled impact markers; recent ones (≤30d) get
 * animated descent streaks + kiloton labels, crossed with the major-shower
 * table. Everything degrades to markers-only when the proxy is down.
 */
import * as Cesium from 'cesium';
import {
  coerceFireball,
  energyClass,
  formatEnergy,
  markerPixels,
  streakPositions,
  highlightReel,
  FIREBALL_HONESTY,
} from './model.js';
import { createFireballSource } from './source.js';
import { showerForFireball } from './showers.js';

const MAX_MARKERS = 400;
const MAX_STREAKS = 25;
const REFRESH_MS = 6 * 3600_000;

function cssColor(hex, alpha = 1) {
  return Cesium.Color.fromCssColorString(hex).withAlpha(alpha);
}

export function createFireballLayer({ source } = {}) {
  if (typeof source?.getFireballs !== 'function')
    throw new TypeError('Fireball layer requires a source');
  let viewer = null;
  let entityGroup = null;
  let timer = null;
  let enabled = false;
  let lastEvents = [];

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

  /** Tracked add: every child entity is registered for explicit removal. */
  function addKid(obj) {
    const e = viewer.entities.add(obj);
    kids.push(e);
    return e;
  }

  function draw(events) {
    clear();
    entityGroup = viewer.entities.add(new Cesium.Entity());
    const markers = events.slice(0, MAX_MARKERS);
    for (const ev of markers) {
      const cls = energyClass(ev.energyKt);
      addKid({
        parent: entityGroup,
        position: Cesium.Cartesian3.fromDegrees(ev.lon, ev.lat, 1000),
        point: {
          pixelSize: markerPixels(ev.energyKt),
          color: cssColor(cls.color, 0.9),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.35),
          outlineWidth: 1,
        },
        description: `${formatEnergy(ev.energyKt)} · ${ev.dateUtc}${ev.altKm ? ` · peak ${ev.altKm} km` : ''}${ev.velKms ? ` · ${ev.velKms} km/s` : ''}`,
      });
    }
    const recent = markers.filter((e) => e.recent).slice(0, MAX_STREAKS);
    for (const ev of recent) {
      const cls = energyClass(ev.energyKt);
      const flat = streakPositions(ev);
      addKid({
        parent: entityGroup,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat.flat()),
          width: 3,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.35,
            color: cssColor(cls.color, 0.95),
          }),
        },
      });
    }
    for (const ev of highlightReel(recent, 8)) {
      const assoc = showerForFireball(ev);
      addKid({
        parent: entityGroup,
        position: Cesium.Cartesian3.fromDegrees(ev.lon, ev.lat, 60000),
        label: {
          text: `${formatEnergy(ev.energyKt)}${assoc ? ` · ${assoc.shower}?` : ''}`,
          font: '11px system-ui, sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
        },
      });
    }
  }

  async function refresh() {
    try {
      const snap = await source.getFireballs({ days: 30 });
      lastEvents = snap.events;
      if (enabled) draw(lastEvents);
      return { ok: true, count: lastEvents.length };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  return {
    id: 'fireballs',
    init(v) {
      viewer = v;
    },
    enable() {
      if (!viewer || enabled) return;
      enabled = true;
      if (lastEvents.length) draw(lastEvents);
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
    },
    disable() {
      enabled = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      clear();
    },
    destroy() {
      this.disable();
      viewer = null;
    },
    getEvents: () => lastEvents,
    refresh,
  };
}

/** Dock panel: highlight reel + shower cross + honesty copy. */
export function createFireballPanel({ layer }) {
  const root = document.createElement('div');
  root.style.cssText = 'margin-top:6px;font-size:11px;color:#dfe9ff;';
  const render = () => {
    const events = layer.getEvents();
    const top = highlightReel(events, 6);
    root.innerHTML = '';
    const title = document.createElement('div');
    title.style.cssText =
      'font-weight:600;letter-spacing:.06em;margin-bottom:4px;';
    title.textContent = events.length
      ? `☄ ${events.length} sensor fireballs (30d recent glow)`
      : '☄ fireballs — waiting on /api/fireballs';
    root.appendChild(title);
    for (const ev of top) {
      const assoc = showerForFireball(ev);
      const row = document.createElement('div');
      row.style.cssText = 'opacity:.92;padding:1px 0;';
      row.textContent = `${formatEnergy(ev.energyKt)} · ${ev.dateUtc.slice(0, 10)} · ${ev.lat.toFixed(1)}°, ${ev.lon.toFixed(1)}°${assoc ? ` · ≈${assoc.shower}` : ''}`;
      root.appendChild(row);
    }
    const note = document.createElement('div');
    note.style.cssText = 'opacity:.55;margin-top:4px;font-size:10px;';
    note.textContent = FIREBALL_HONESTY;
    root.appendChild(note);
  };
  const timer = setInterval(render, 60000);
  render();
  return {
    element: root,
    sync: render,
    destroy() {
      clearInterval(timer);
      root.remove();
    },
  };
}

/**
 * Fail-soft mount for initFrontier. Never throws; returns a cleanup fn.
 * The parent wires the dock section (see INTEGRATION.md).
 */
export function initFireballs({ viewer } = {}) {
  try {
    if (!viewer) return () => {};
    const layer = createFireballLayer({ source: createFireballSource({}) });
    layer.init(viewer);
    layer.enable();
    return () => layer.destroy();
  } catch (error) {
    console.warn('[frontier] fireballs failed:', error);
    return () => {};
  }
}

/** Generic fail-soft entry point required by the Wave 3 mount contract. */
export { initFireballs as init };
