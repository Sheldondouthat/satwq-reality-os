/**
 * Ocean twin (wave3 sci-fi B #2) — the 70% of Earth nobody maps.
 *
 * Three sub-layers, each independently toggleable and fail-soft:
 *  1. Current particles — advected on the bundled RTOFS snapshot
 *     (see model.js CURRENT_SNAPSHOT; snapshot, NOT live).
 *  2. Submarine-cable overlay — TeleGeography geometries via the existing
 *     bundled cable source (src/layers/submarineCables/bundledSource.js),
 *     thinned to the longest systems.
 *  3. Argo float constellation — W5's /api/argo shape via their client
 *     (src/frontier/wave3/argo/source.js). Degrades to a "provider pending"
 *     note when /api/argo is not registered yet.
 *
 * init(viewer, { mount }) → { destroy }.
 */
import * as Cesium from 'cesium';
import {
  CURRENT_SNAPSHOT,
  PARTICLE_COUNT,
  buildSpatialIndex,
  sampleCurrent,
  createParticles,
  advectParticles,
  validateSnapshot,
  respawn,
} from './model.js';
import { createBundledCableSource } from '../../../layers/submarineCables/bundledSource.js';
import { createArgoSource } from '../argo/source.js';

const CABLE_CAP = 80;
const FRAME_DT_H = 2; // simulated hours per rendered frame

function cableLengthKm(coords) {
  let total = 0;
  for (const line of coords) {
    for (let i = 1; i < line.length; i += 1) {
      const [x1, y1] = line[i - 1];
      const [x2, y2] = line[i];
      total += Math.hypot((x2 - x1) * 111, (y2 - y1) * 111 * Math.cos(((y1 + y2) / 2 * Math.PI) / 180));
    }
  }
  return total;
}

function tempColor(tempC) {
  if (!Number.isFinite(tempC)) return Cesium.Color.fromCssColorString('#9fb4dd');
  const t = Math.min(1, Math.max(0, (tempC - 0) / 30));
  return Cesium.Color.fromHsl(0.62 - 0.62 * t, 0.9, 0.55, 0.95);
}

export function init(viewer, { mount = null } = {}) {
  if (!viewer || typeof document === 'undefined') return null;
  let destroyed = false;
  const state = { currents: false, cables: false, argo: false };

  // — particle primitives —
  const points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
  let particles = null;
  let spatial = null;
  let gridPoints = null;
  let timer = null;

  function syncPrimitives() {
    points.removeAll();
    if (!state.currents || !particles) return;
    for (const p of particles) {
      points.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 5000),
        pixelSize: 2,
        color: Cesium.Color.fromCssColorString('#35e0ff').withAlpha(0.75),
      });
    }
  }

  async function ensureCurrents() {
    if (gridPoints) return true;
    try {
      const mod = await import('./data/currents_snapshot.json');
      const doc = mod?.default ?? mod;
      const check = validateSnapshot(doc);
      if (!check.ok) throw new Error(`currents snapshot invalid: ${check.reason}`);
      gridPoints = doc.points;
      spatial = buildSpatialIndex(gridPoints);
      particles = createParticles(gridPoints, PARTICLE_COUNT);
      syncPrimitives();
      return true;
    } catch (error) {
      console.warn('[oceanTwin] currents unavailable:', error);
      note('Current particles unavailable (snapshot failed to load).');
      return false;
    }
  }

  function startCurrents() {
    if (timer) return;
    timer = setInterval(() => {
      if (destroyed || !state.currents || !particles) return;
      advectParticles(particles, spatial, gridPoints, FRAME_DT_H);
      syncPrimitives();
    }, 120);
  }

  function stopCurrents() {
    if (timer) { clearInterval(timer); timer = null; }
    if (points) { try { points.removeAll(); } catch {} }
  }

  // — cable overlay —
  const cableEntities = [];
  async function setCables(on) {
    for (const e of cableEntities.splice(0)) {
      try { viewer.entities.remove(e); } catch {}
    }
    if (!on || destroyed) return;
    try {
      const source = createBundledCableSource({});
      const { cables } = await source.fetch();
      const feats = (cables?.features ?? []).slice();
      feats.sort((a, b) => cableLengthKm(b.geometry.coordinates) - cableLengthKm(a.geometry.coordinates));
      let drawn = 0;
      for (const f of feats) {
        if (drawn >= CABLE_CAP) break;
        const lines = f.geometry?.coordinates ?? [];
        for (const line of lines) {
          if (line.length < 2) continue;
          try {
            cableEntities.push(
              viewer.entities.add({
                polyline: {
                  positions: line.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 3000)),
                  width: 1,
                  material: Cesium.Color.fromCssColorString('#ff9f1a').withAlpha(0.4),
                },
              }),
            );
          } catch { /* skip bad geometry */ }
        }
        drawn += 1;
      }
      note(`Cable overlay: ${drawn} longest systems (TeleGeography, CC BY-NC-SA).`);
    } catch (error) {
      console.warn('[oceanTwin] cables unavailable:', error);
      note('Cable overlay unavailable (bundled source failed).');
    }
  }

  // — Argo floats (W5's shape) —
  const argoEntities = [];
  const argo = createArgoSource({});
  function renderArgo(snapshot) {
    for (const e of argoEntities.splice(0)) {
      try { viewer.entities.remove(e); } catch {}
    }
    if (!state.argo || destroyed) return;
    const floats = snapshot?.floats ?? [];
    if (snapshot?.unavailable || floats.length === 0) {
      note('Argo provider pending — float constellation will appear once /api/argo is registered (worker W5).');
      return;
    }
    for (const f of floats.slice(0, 4000)) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue;
      try {
        argoEntities.push(
          viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 8000),
            point: {
              pixelSize: 4,
              color: tempColor(f.surfaceTempC),
              outlineColor: Cesium.Color.WHITE.withAlpha(0.4),
              outlineWidth: 1,
            },
            description: `Argo ${f.wmo ?? '?'} — ${Number.isFinite(f.surfaceTempC) ? `${f.surfaceTempC.toFixed(1)}°C surface` : 'no temp sample'} (positions are float fixes; drift between fixes unknown)`,
          }),
        );
      } catch { /* skip */ }
    }
    note(`Argo: ${floats.length} floats (Ifremer ERDDAP via /api/argo). Temp = sampled near-surface median, not calibrated SST.`);
  }
  argo.start((snap) => { if (!destroyed) renderArgo(snap); });

  // — UI —
  const panel = document.createElement('div');
  panel.style.cssText =
    'margin-top:8px;padding:8px;border-radius:8px;background:rgba(10,18,32,.7);' +
    'border:1px solid rgba(120,180,255,.2);font:12px/1.5 system-ui,sans-serif;color:#dfe9ff;';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:10px;letter-spacing:.12em;color:#8aa4d6;font-weight:600;';
  title.textContent = '🌊 OCEAN TWIN';
  const chipRow = document.createElement('div');
  const noteEl = document.createElement('div');
  noteEl.style.cssText = 'color:#9fb4dd;font-size:10px;margin-top:4px;min-height:16px;';
  const honesty = document.createElement('div');
  honesty.style.cssText = 'color:#7d8fb5;font-size:9px;margin-top:4px;line-height:1.4;';
  honesty.textContent =
    'Stylized twin, not telemetry. ' + CURRENT_SNAPSHOT.note +
    ' Cables: TeleGeography (CC BY-NC-SA 3.0, non-commercial).';

  function note(text) { noteEl.textContent = text; }

  function makeChip(label, key, onToggle) {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-pressed', 'false');
    b.style.cssText =
      'margin:2px;padding:5px 9px;border-radius:20px;border:1px solid rgba(120,180,255,.35);' +
      'background:rgba(30,45,70,.6);color:#dfe9ff;cursor:pointer;font-size:11px;';
    b.addEventListener('click', async () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      b.style.background = on ? 'rgba(90,160,255,.35)' : 'rgba(30,45,70,.6)';
      state[key] = on;
      try { await onToggle(on); } catch (error) { console.warn('[oceanTwin]', error); }
    });
    return b;
  }

  chipRow.append(
    makeChip('🌀 currents', 'currents', async (on) => {
      if (on) { if (await ensureCurrents()) startCurrents(); else state.currents = false; }
      else stopCurrents();
    }),
    makeChip('🔌 cables', 'cables', (on) => setCables(on)),
    makeChip('🛰️ argo floats', 'argo', async (on) => {
      if (on) {
        const r = await argo.refresh();
        if (!r.ok && !r.snapshot) note('Argo provider pending — float constellation will appear once /api/argo is registered (worker W5).');
        else renderArgo(r.snapshot);
      } else renderArgo(null);
    }),
  );

  panel.append(title, chipRow, noteEl, honesty);
  (mount ?? document.body).appendChild(panel);

  return {
    destroy() {
      destroyed = true;
      stopCurrents();
      try { argo.stop(); } catch {}
      try { viewer.scene.primitives.remove(points); } catch {}
      for (const e of [...cableEntities, ...argoEntities]) {
        try { viewer.entities.remove(e); } catch {}
      }
      panel.remove();
    },
  };
}

export { CURRENT_SNAPSHOT, sampleCurrent, buildSpatialIndex, createParticles, advectParticles, respawn };
