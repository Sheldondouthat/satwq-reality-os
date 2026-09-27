/**
 * SOCRATES conjunction theater (3.3) — Cesium view + fail-soft mount.
 *
 * Top near-misses as convergence arcs between the two satellites' SGP4
 * positions at TCA, with live countdown labels. Events without TLE
 * enrichment still appear in the panel (countdown only).
 */
import * as Cesium from 'cesium';
import {
  riskTier,
  formatCountdown,
  tcaPosition,
  convergenceArc,
  rankConjunctions,
  CONJUNCTION_HONESTY,
} from './model.js';
import { createConjunctionSource } from './source.js';

const MAX_ARCS = 8;
const REFRESH_MS = 8 * 3600_000;
const COUNTDOWN_MS = 30_000;

function cssColor(hex, alpha = 1) {
  return Cesium.Color.fromCssColorString(hex).withAlpha(alpha);
}

export function createConjunctionLayer({ source } = {}) {
  if (typeof source?.getConjunctions !== 'function')
    throw new TypeError('Conjunction layer requires a source');
  let viewer = null;
  let entityGroup = null;
  let refreshTimer = null;
  let countdownTimer = null;
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
    const arced = events.filter((e) => e.tle1 && e.tle2).slice(0, MAX_ARCS);
    for (const ev of rankConjunctions(arced)) {
      const tier = riskTier(ev);
      const p1 = tcaPosition(ev.tle1, ev.tcaMs);
      const p2 = tcaPosition(ev.tle2, ev.tcaMs);
      if (!p1 || !p2) continue;
      const arc = convergenceArc(p1, p2);
      const mid = arc[Math.floor(arc.length / 2)];
      for (const p of [p1, p2]) {
        addKid({
          parent: entityGroup,
          position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altKm * 1000),
          point: {
            pixelSize: 10,
            color: cssColor(tier.color, 0.95),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.5),
            outlineWidth: 1,
          },
        });
      }
      addKid({
        parent: entityGroup,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(arc.flat()),
          width: 2,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.4,
            color: cssColor(tier.color, 0.9),
          }),
        },
      });
      addKid({
        parent: entityGroup,
        position: Cesium.Cartesian3.fromDegrees(mid[0], mid[1], mid[2] + 40000),
        label: {
          text: new Cesium.CallbackProperty(() =>
            `${ev.name1} × ${ev.name2}\n${ev.minRangeKm.toFixed(2)} km · p=${ev.maxProb.toExponential(1)}\n${formatCountdown(ev.tcaMs)}`,
          false),
          font: '11px system-ui, sans-serif',
          fillColor: cssColor(tier.color, 1),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        },
        _conjunctionId: ev.id,
      });
    }
  }

  async function refresh() {
    try {
      const snap = await source.getConjunctions({ max: 40 });
      lastEvents = snap.events;
      if (enabled) draw(lastEvents);
      return { ok: true, count: lastEvents.length };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  return {
    id: 'conjunctions',
    init(v) { viewer = v; },
    enable() {
      if (!viewer || enabled) return;
      enabled = true;
      refresh();
      refreshTimer = setInterval(refresh, REFRESH_MS);
      countdownTimer = setInterval(() => {}, COUNTDOWN_MS); // labels self-update via CallbackProperty
    },
    disable() {
      enabled = false;
      for (const t of [refreshTimer, countdownTimer]) if (t) clearInterval(t);
      refreshTimer = countdownTimer = null;
      clear();
    },
    destroy() { this.disable(); viewer = null; },
    getEvents: () => lastEvents,
    refresh,
  };
}

/** Dock panel: risk-ranked near-miss list with live countdowns. */
export function createConjunctionPanel({ layer }) {
  const root = document.createElement('div');
  root.style.cssText = 'margin-top:6px;font-size:11px;color:#dfe9ff;';
  const render = () => {
    const events = rankConjunctions(layer.getEvents()).slice(0, 10);
    root.innerHTML = '';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;letter-spacing:.06em;margin-bottom:4px;';
    title.textContent = events.length ? `⚠ ${layer.getEvents().length} near-misses ≤5 km (7d)` : '⚠ conjunctions — waiting on /api/conjunctions';
    root.appendChild(title);
    for (const ev of events) {
      const tier = riskTier(ev);
      const row = document.createElement('div');
      row.style.cssText = `padding:1px 0;color:${tier.color};`;
      row.textContent = `${tier.label} ${ev.name1} × ${ev.name2} · ${ev.minRangeKm.toFixed(2)} km · ${formatCountdown(ev.tcaMs)}`;
      root.appendChild(row);
    }
    const note = document.createElement('div');
    note.style.cssText = 'opacity:.55;margin-top:4px;font-size:10px;color:#dfe9ff;';
    note.textContent = CONJUNCTION_HONESTY;
    root.appendChild(note);
  };
  const timer = setInterval(render, COUNTDOWN_MS);
  render();
  return { element: root, sync: render, destroy() { clearInterval(timer); root.remove(); } };
}

/** Fail-soft mount for initFrontier. Never throws; returns a cleanup fn. */
export function initConjunctions({ viewer } = {}) {
  try {
    if (!viewer) return () => {};
    const layer = createConjunctionLayer({ source: createConjunctionSource({}) });
    layer.init(viewer);
    layer.enable();
    return () => layer.destroy();
  } catch (error) {
    console.warn('[frontier] conjunctions failed:', error);
    return () => {};
  }
}

/** Generic fail-soft entry point required by the Wave 3 mount contract. */
export { initConjunctions as init };
