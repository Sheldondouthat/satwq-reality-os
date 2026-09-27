/**
 * Satellite visibility oracle — "look up now". Wave 3 (1.6).
 *
 * Fail-soft mount: click anywhere on the globe to set an observer point;
 * the oracle reports which satellites (existing CelesTrak TLE pipeline) are
 * above the horizon AND sunlit right now, plus tonight's naked-eye passes
 * (stations + 100 brightest + Starlink candidate pre-filter) as globe arcs.
 * Passes are twilight-filtered: observer Sun elevation in [-18°, -6°].
 *
 * SGP4 via satellite.js; Sun/shadow math from src/data/satellitePass.js
 * (USNO low-precision Sun, cylindrical Earth shadow — labeled models).
 * This is the ONLY file in satOracle that imports Cesium.
 */
import * as Cesium from 'cesium';
import {
  parseTleText,
  currentlyVisible,
  prefilterCandidates,
  tonightsVisiblePasses,
  passArcPoints,
  observerSolarElevation,
} from './oracle.js';

export * from './oracle.js';

const TLE_GROUPS = ['stations', 'visual', 'starlink'];
const MAX_STARLINK_EVAL = 900; // exact passes only on pre-filtered candidates

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (text) node.textContent = text;
  return node;
}

const PANEL_STYLE =
  'position:fixed;top:12px;right:12px;z-index:9990;width:320px;max-height:70vh;overflow:auto;' +
  'background:rgba(8,12,20,.92);border:1px solid rgba(120,180,255,.25);border-radius:10px;' +
  'color:#dfe9ff;font:12px/1.5 system-ui,sans-serif;padding:12px;backdrop-filter:blur(6px);';

async function fetchTleGroup(group, fetchImpl) {
  const f = fetchImpl || fetch;
  const response = await f(`/api/celestrak/${group}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`celestrak_${group}_${response.status}`);
  return parseTleText(await response.text());
}

export function initSatOracle({ viewer, fetchImpl } = {}) {
  if (!viewer || typeof document === 'undefined') return null;
  let enabled = false;
  let panel = null;
  let dataSource = null;
  let clickHandler = null;
  let tleCache = null;

  async function loadTles() {
    if (tleCache) return tleCache;
    const [stations, visual, starlink] = await Promise.all(
      TLE_GROUPS.map((g) => fetchTleGroup(g, fetchImpl).catch(() => [])),
    );
    tleCache = { stations, visual, starlink };
    setTimeout(() => { tleCache = null; }, 30 * 60_000); // TLEs refresh
    return tleCache;
  }

  function clearArcs() {
    if (dataSource) {
      viewer.dataSources.remove(dataSource, true);
      dataSource = null;
    }
  }

  function drawPassArcs(passes, satByName) {
    clearArcs();
    dataSource = new Cesium.CustomDataSource('sat-oracle-passes');
    for (const pass of passes) {
      const sat = satByName.get(pass.name);
      if (!sat) continue;
      const pts = passArcPoints(sat.satrec, pass.riseMs, pass.setMs);
      if (pts.length < 2) continue;
      dataSource.entities.add({
        name: pass.name,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(
            pts.flatMap((p) => [p.lonDeg, p.latDeg, p.altKm * 1000]),
          ),
          width: 2,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.25,
            color: Cesium.Color.fromCssColorString('#7fd4ff').withAlpha(0.9),
          }),
        },
        description: `${pass.name}<br>peak ${new Date(pass.peakMs).toUTCString()}<br>` +
          `max elev ${pass.maxElevDeg.toFixed(1)}° · Sun ${pass.sunElevAtPeakDeg.toFixed(1)}°`,
      });
    }
    viewer.dataSources.add(dataSource);
  }

  function renderPanel(host, { lat, lon, nowVisible, passes, sunElev, tleCounts }) {
    host.innerHTML = '';
    host.appendChild(el('div', { style: 'font-weight:700;color:#9fc2ff;margin-bottom:6px;' },
      `🛰 LOOK UP NOW — ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`));
    host.appendChild(el('div', { style: 'color:#8aa4d6;font-size:11px;margin-bottom:8px;' },
      `Sun ${sunElev.toFixed(1)}° · ${tleCounts} TLEs (SGP4 model; cylindrical shadow)`));
    host.appendChild(el('div', { style: 'font-weight:600;margin:6px 0 4px;' },
      `Visible now (${nowVisible.length})`));
    if (nowVisible.length === 0) {
      host.appendChild(el('div', { style: 'color:#8aa4d6;' },
        'Nothing sunlit above the horizon right now.'));
    } else {
      const list = el('div', {});
      for (const s of nowVisible.slice(0, 25)) {
        list.appendChild(el('div', {},
          `${s.name} — elev ${s.elevDeg.toFixed(1)}°, az ${s.azDeg.toFixed(0)}°`));
      }
      host.appendChild(list);
    }
    host.appendChild(el('div', { style: 'font-weight:600;margin:8px 0 4px;' },
      `Tonight's twilight passes (${passes.length})`));
    if (passes.length === 0) {
      host.appendChild(el('div', { style: 'color:#8aa4d6;' }, 'No twilight passes found.'));
    } else {
      const list = el('div', {});
      for (const p of passes.slice(0, 25)) {
        list.appendChild(el('div', {},
          `${p.name} — ${new Date(p.peakMs).toISOString().slice(11, 16)}Z, ` +
          `peak ${p.maxElevDeg.toFixed(0)}°, Sun ${p.sunElevAtPeakDeg.toFixed(1)}°`));
      }
      host.appendChild(list);
    }
  }

  async function evaluateAt(lat, lon) {
    const nowMs = Date.now();
    const { stations, visual, starlink } = await loadTles();
    const small = [...stations, ...visual];
    const candidates = prefilterCandidates(starlink.slice(0, 8000), lat, lon, nowMs);
    const evalSet = [...small, ...candidates.slice(0, MAX_STARLINK_EVAL)];
    const satByName = new Map(evalSet.map((s) => [s.name, s]));
    const nowVisible = currentlyVisible(evalSet, lat, lon, nowMs);
    const passes = tonightsVisiblePasses(evalSet, lat, lon, nowMs);
    const sunElev = observerSolarElevation(lat, lon, nowMs);
    drawPassArcs(passes, satByName);
    renderPanel(panel, {
      lat, lon, nowVisible, passes, sunElev, tleCounts: evalSet.length,
    });
  }

  function onGlobeClick(movement) {
    const cartesian = viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
    if (!cartesian) return;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const lat = (carto.latitude * 180) / Math.PI;
    const lon = (carto.longitude * 180) / Math.PI;
    panel.querySelector('[data-status]')?.remove();
    const status = el('div', { 'data-status': '1', style: 'color:#8aa4d6;' }, 'Computing…');
    panel.appendChild(status);
    evaluateAt(lat, lon).catch((error) => {
      status.textContent = `Oracle failed: ${error?.message ?? error}`;
    });
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    panel = el('div', { id: 'satwq-sat-oracle', style: PANEL_STYLE });
    panel.appendChild(el('div', { style: 'color:#8aa4d6;' },
      '🛰 Click anywhere on the globe to set your observer point.'));
    document.body.appendChild(panel);
    clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction(onGlobeClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function disable() {
    if (!enabled) return;
    enabled = false;
    clickHandler?.destroy();
    clickHandler = null;
    clearArcs();
    panel?.remove();
    panel = null;
  }

  return {
    enable,
    disable,
    isEnabled: () => enabled,
    destroy: () => disable(),
  };
}

/** Dock mounter for initFrontier: section + toggle chip, fail-soft. */
export function mountSatOracleDock({ section, chip, t, oracle } = {}) {
  if (!section || !chip || !oracle) return null;
  const host = section(t ? t('feature.satOracle') : 'SAT ORACLE');
  host.appendChild(
    chip('🛰 Look up', (on) => (on ? oracle.enable() : oracle.disable()), false),
  );
  return { element: host, destroy() {} };
}
