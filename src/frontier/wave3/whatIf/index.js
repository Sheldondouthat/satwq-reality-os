/**
 * What-if simulator (wave3 sci-fi B #3) — war-room overlay.
 *
 * Click the globe to drop a pin, pick a scenario, read the rings. All physics
 * comes from model.js (public scaling laws); this file is DOM + Cesium only.
 *
 * init(viewer, { mount }) → { destroy }. Fail-soft: never throws into the host.
 */
import * as Cesium from 'cesium';
import {
  SCENARIOS,
  WHATIF_HONESTY,
  simulateAsteroid,
  simulateBurst,
  simulateTsunami,
  ringPolygon,
} from './model.js';

const RING_COLORS = {
  r20psiKm: '#ff2d2d',
  r5psiKm: '#ff8c1a',
  r1psiKm: '#ffd21a',
  thermalKm: '#ff5ad0',
};

export function init(viewer, { mount = null } = {}) {
  if (!viewer || typeof document === 'undefined') return null;
  const entities = viewer.entities;
  const owned = [];
  let pin = null; // { lat, lon }
  let destroyed = false;
  let picking = false;

  function clear() {
    for (const e of owned.splice(0)) {
      try {
        entities.remove(e);
      } catch {
        /* best effort */
      }
    }
  }

  function drawRing(lat, lon, radiusKm, color, label) {
    const pts = ringPolygon(lat, lon, radiusKm).map((p) =>
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
    );
    owned.push(
      entities.add({
        polyline: {
          positions: pts,
          width: 2,
          material: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
          clampToGround: true,
        },
      }),
    );
    const labelPt = ringPolygon(lat, lon, radiusKm, 1)[0];
    owned.push(
      entities.add({
        position: Cesium.Cartesian3.fromDegrees(labelPt.lon, labelPt.lat, 2000),
        label: {
          text: label,
          font: '11px system-ui',
          fillColor: Cesium.Color.fromCssColorString(color),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -12),
        },
      }),
    );
  }

  function drawPin(lat, lon) {
    owned.push(
      entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, 1000),
        point: {
          pixelSize: 10,
          color: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
        },
      }),
    );
  }

  function fmtKm(km) {
    return km >= 100 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
  }

  function render() {
    clear();
    const scenario = scenarioSel.value;
    const pinText = pin
      ? `${pin.lat.toFixed(2)}°, ${pin.lon.toFixed(2)}°`
      : 'no pin — click the globe';
    let html = `<div style="color:#dfe9ff;font-size:11px;margin-bottom:4px;">📍 ${pinText}</div>`;
    if (!pin) {
      results.innerHTML = html;
      return;
    }
    drawPin(pin.lat, pin.lon);
    try {
      if (scenario === 'asteroid') {
        const r = simulateAsteroid({
          diameterM: Number(diaInput.value) || 100,
          densityKgM3: Number(denInput.value) || 3000,
          velocityKmS: Number(velInput.value) || 20,
        });
        drawRing(
          pin.lat,
          pin.lon,
          r.overpressure.r20psiKm,
          RING_COLORS.r20psiKm,
          `20 psi — ${fmtKm(r.overpressure.r20psiKm)}`,
        );
        drawRing(
          pin.lat,
          pin.lon,
          r.overpressure.r5psiKm,
          RING_COLORS.r5psiKm,
          `5 psi — ${fmtKm(r.overpressure.r5psiKm)}`,
        );
        drawRing(
          pin.lat,
          pin.lon,
          r.overpressure.r1psiKm,
          RING_COLORS.r1psiKm,
          `1 psi — ${fmtKm(r.overpressure.r1psiKm)}`,
        );
        drawRing(
          pin.lat,
          pin.lon,
          r.thermalKm,
          RING_COLORS.thermalKm,
          `3rd° burns — ${fmtKm(r.thermalKm)}`,
        );
        html += `<div>💥 <b>${r.energyMt >= 1 ? r.energyMt.toFixed(1) + ' Mt' : (r.energyMt * 1000).toFixed(0) + ' kt'}</b> TNT equivalent</div>`;
        html += `<div>🕳️ crater ≈ ${r.craterKm.toFixed(1)} km diameter</div>`;
        html += `<div>🔥 thermal (3rd-degree) ≈ ${fmtKm(r.thermalKm)}</div>`;
      } else if (scenario === 'burst') {
        const r = simulateBurst({ yieldKt: Number(yieldInput.value) || 1000 });
        drawRing(
          pin.lat,
          pin.lon,
          r.overpressure.r20psiKm,
          RING_COLORS.r20psiKm,
          `20 psi — ${fmtKm(r.overpressure.r20psiKm)}`,
        );
        drawRing(
          pin.lat,
          pin.lon,
          r.overpressure.r5psiKm,
          RING_COLORS.r5psiKm,
          `5 psi — ${fmtKm(r.overpressure.r5psiKm)}`,
        );
        drawRing(
          pin.lat,
          pin.lon,
          r.overpressure.r1psiKm,
          RING_COLORS.r1psiKm,
          `1 psi — ${fmtKm(r.overpressure.r1psiKm)}`,
        );
        html += `<div>💥 <b>${r.yieldKt >= 1000 ? (r.yieldKt / 1000).toFixed(1) + ' Mt' : r.yieldKt.toFixed(0) + ' kt'}</b> surface burst</div>`;
        html += `<div>🏚️ 5-psi (most buildings down) ≈ ${fmtKm(r.overpressure.r5psiKm)}</div>`;
      } else {
        const r = simulateTsunami({});
        for (const ring of r.rings) {
          drawRing(
            pin.lat,
            pin.lon,
            ring.radiusKm,
            '#1a9fff',
            `T+${ring.hour}h — ${fmtKm(ring.radiusKm)}`,
          );
        }
        html += `<div>🌊 wave speed ≈ ${r.waveSpeedKmh.toFixed(0)} km/h (√(g·4000 m))</div>`;
        html += r.rings
          .map((x) => `<div>⏱️ +${x.hour}h → ${fmtKm(x.radiusKm)}</div>`)
          .join('');
      }
    } catch (error) {
      html += `<div style="color:#ff8080;">model error: ${error?.message ?? error}</div>`;
    }
    results.innerHTML = html;
  }

  // — click-to-pin —
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => {
    if (!picking || destroyed) return;
    const picked = viewer.camera.pickEllipsoid(
      click.position,
      viewer.scene.globe.ellipsoid,
    );
    if (!picked) return;
    const c = Cesium.Cartographic.fromCartesian(picked);
    pin = {
      lat: (c.latitude * 180) / Math.PI,
      lon: (c.longitude * 180) / Math.PI,
    };
    picking = false;
    pickBtn.textContent = '📍 drop pin';
    render();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // — UI —
  const panel = document.createElement('div');
  panel.style.cssText =
    'margin-top:8px;padding:8px;border-radius:8px;background:rgba(10,18,32,.7);' +
    'border:1px solid rgba(120,180,255,.2);font:12px/1.5 system-ui,sans-serif;color:#dfe9ff;';
  panel.innerHTML = `
    <div style="font-size:10px;letter-spacing:.12em;color:#8aa4d6;font-weight:600;">☄️ WHAT-IF</div>`;
  const pickBtn = document.createElement('button');
  pickBtn.textContent = '📍 drop pin';
  pickBtn.style.cssText =
    'margin:4px 4px 4px 0;padding:5px 9px;border-radius:20px;border:1px solid rgba(120,180,255,.35);background:rgba(30,45,70,.6);color:#dfe9ff;cursor:pointer;font-size:11px;';
  pickBtn.addEventListener('click', () => {
    picking = !picking;
    pickBtn.textContent = picking ? '✖ cancel (click globe)' : '📍 drop pin';
  });
  const scenarioSel = document.createElement('select');
  for (const [k, v] of Object.entries(SCENARIOS)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = v;
    scenarioSel.appendChild(o);
  }
  scenarioSel.style.cssText =
    'margin:4px 0;padding:4px;border-radius:6px;background:#0a1220;color:#dfe9ff;border:1px solid rgba(120,180,255,.35);width:100%;';
  scenarioSel.addEventListener('change', render);

  const paramBox = document.createElement('div');
  paramBox.style.cssText = 'margin:4px 0;';
  const diaInput = document.createElement('input');
  const denInput = document.createElement('input');
  const velInput = document.createElement('input');
  const yieldInput = document.createElement('input');
  for (const [inp, ph, val] of [
    [diaInput, 'diameter (m)', '100'],
    [denInput, 'density (kg/m³)', '3000'],
    [velInput, 'velocity (km/s)', '20'],
    [yieldInput, 'yield (kt)', '1000'],
  ]) {
    inp.placeholder = ph;
    inp.value = val;
    inp.type = 'number';
    inp.style.cssText =
      'width:32%;margin:2px 1px;padding:4px;border-radius:6px;background:#0a1220;color:#dfe9ff;border:1px solid rgba(120,180,255,.35);font-size:11px;';
    inp.addEventListener('change', render);
  }
  function syncParams() {
    paramBox.innerHTML = '';
    if (scenarioSel.value === 'asteroid')
      paramBox.append(diaInput, denInput, velInput);
    else if (scenarioSel.value === 'burst') paramBox.appendChild(yieldInput);
  }
  scenarioSel.addEventListener('change', syncParams);
  syncParams();

  const results = document.createElement('div');
  results.style.cssText = 'margin-top:4px;';
  const honesty = document.createElement('div');
  honesty.style.cssText =
    'color:#7d8fb5;font-size:9px;margin-top:6px;line-height:1.4;';
  honesty.textContent = WHATIF_HONESTY;

  panel.append(pickBtn, scenarioSel, paramBox, results, honesty);
  (mount ?? document.body).appendChild(panel);
  render();

  return {
    render,
    setPin: (lat, lon) => {
      pin = { lat, lon };
      render();
    },
    getPin: () => pin,
    destroy() {
      destroyed = true;
      handler.destroy();
      clear();
      panel.remove();
    },
  };
}

export { SCENARIOS, WHATIF_HONESTY };
