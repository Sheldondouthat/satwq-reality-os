/**
 * Wave 3 — Eyes-on countdown.
 *
 * The user picks any point on Earth; we compute the next overpass of an
 * imaging-capable satellite via SGP4 from CelesTrak TLEs (served by the
 * existing /api/celestrak/<group> proxy — no new server provider needed).
 *
 * Pure compute: TLE parse → satrec → findNextSatellitePass (SGP4) per
 * candidate → earliest rise wins → live countdown + ground-track arc.
 *
 * Physics honesty: "imaging-capable" is a HEURISTIC name-match over the
 * CelesTrak `resource` group (Landsat, Sentinel-2, SPOT, WorldView, …) —
 * labeled as such in the UI. Elevation ≥ 25° counts as "eyes on" (a usable
 * imaging geometry), stated in the panel. Countdown is derived from SGP4,
 * not from a schedule feed.
 *
 * Fail-soft: TLE fetch failure → error state; no viewer → no ground track
 * and no click-to-pick, countdown math still works. init() never throws.
 * Returns a cleanup function.
 */

import { twoline2satrec, propagate, gstime, eciToEcf } from 'satellite.js';
import { findNextSatellitePass } from '../../../data/satellitePass.js';
import { t } from '../../../themes/engine.js';

const TLE_GROUP_URL = '/api/celestrak/resource';
const MIN_ELEV_DEG = 25;
const HORIZON_HOURS = 48;

/**
 * Name fragments identifying (heuristically) imaging-capable spacecraft in
 * the CelesTrak `resource` group. A name match is a CANDIDATE, not a
 * capability claim — optical vs SAR vs resolution are not distinguished.
 */
export const IMAGING_PATTERNS = [
  'LANDSAT',
  'SENTINEL-2',
  'SENTINEL 2',
  'SPOT',
  'WORLDVIEW',
  'GEOEYE',
  'PLEIADES',
  'SKYSAT',
  'IKONOS',
  'QUICKBIRD',
  'CARTOSAT',
  'KOMPSAT',
  'FORMOSAT',
  'EROS',
  'ZY-3',
  'GAOFEN',
  'JILIN',
  'SUPERDOVE',
  'FLOCK',
  'TERRASAR',
  'TANDEM',
  'ALOS',
  'RADARSAT',
  'COSMO-SKYMED',
  'SAOCOM',
  'PAZ',
  'NUSAT',
  'ICEYE',
];

/** Heuristic imaging-candidate name match. Pure. Exported for tests. */
export function isImagingCandidate(name) {
  if (typeof name !== 'string') return false;
  const upper = name.toUpperCase();
  return IMAGING_PATTERNS.some((p) => upper.includes(p));
}

/**
 * Parse CelesTrak 3-line TLE text into [{name, line1, line2}].
 * Pure. Exported for tests.
 */
export function parseTleText(text) {
  if (typeof text !== 'string') return [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const out = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const [name, line1, line2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (line1.startsWith('1 ') && line2.startsWith('2 ')) {
      out.push({ name: name.trim(), line1, line2 });
    }
  }
  return out;
}

/** "04:12:33" from a millisecond delta. Pure. Exported for tests. */
export function formatCountdown(deltaMs) {
  const total = Math.max(0, Math.floor(deltaMs / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function formatUtc(ms) {
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

/**
 * Find the earliest imaging overpass for an observer. Candidates are
 * {name, satrec}. Runs in time-sliced chunks so the UI stays responsive.
 * Pure w.r.t. its inputs (SGP4 math only). Exported for tests.
 */
export async function findEarliestPass(
  candidates,
  latDeg,
  lonDeg,
  fromMs,
  onProgress,
) {
  let best = null;
  let done = 0;
  for (const cand of candidates) {
    let pass = null;
    try {
      pass = findNextSatellitePass({
        satrec: cand.satrec,
        latDeg,
        lonDeg,
        fromMs,
        minElevDeg: MIN_ELEV_DEG,
        horizonHours: HORIZON_HOURS,
        coarseStepSec: 90,
        fineStepSec: 5,
      });
    } catch {
      pass = null;
    }
    if (pass && (!best || pass.riseMs < best.pass.riseMs)) {
      best = { name: cand.name, pass };
    }
    done++;
    if (onProgress) onProgress(done, candidates.length);
    // Yield to the event loop every few satellites.
    if (done % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return best;
}

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (text) node.textContent = text;
  return node;
}

const INPUT_STYLE =
  'width:70px;padding:4px 6px;border-radius:6px;border:1px solid rgba(120,180,255,.35);' +
  'background:rgba(10,18,32,.9);color:#dfe9ff;font-size:11px;';

/**
 * Mount the eyes-on countdown. `dock` is the frontier dock body
 * (falls back to a floating panel when absent). Returns cleanup.
 */
export function init({ viewer, dock } = {}) {
  if (typeof document === 'undefined') return null;

  let section = null;
  let trackEntities = [];
  let countdownTimer = null;
  let clickHandler = null;
  let picking = false;
  let currentBest = null;
  let observer = { lat: NaN, lon: NaN };

  const status = el(
    'div',
    { style: 'margin-top:6px;min-height:18px;color:#9fc2ff;font-size:11px;' },
    'Pick a point, then find the next imaging overpass.',
  );
  const latInput = el('input', {
    type: 'text',
    placeholder: 'lat',
    'aria-label': 'Latitude',
    style: INPUT_STYLE,
  });
  const lonInput = el('input', {
    type: 'text',
    placeholder: 'lon',
    'aria-label': 'Longitude',
    style: INPUT_STYLE,
  });

  const findBtn = el(
    'button',
    {
      style:
        'margin:2px;padding:5px 9px;border-radius:20px;border:1px solid rgba(120,180,255,.35);' +
        'background:rgba(30,45,70,.6);color:#dfe9ff;cursor:pointer;font-size:11px;',
    },
    '👁 Find next eyes-on',
  );

  const clearTrack = () => {
    if (viewer) {
      for (const e of trackEntities) {
        try {
          viewer.entities.remove(e);
        } catch {}
      }
    }
    trackEntities = [];
  };

  async function drawGroundTrack(satrec, riseMs, setMs) {
    clearTrack();
    if (!viewer) return;
    let C;
    try {
      C = await import('cesium');
    } catch {
      return;
    }
    const { Cartesian3, Color } = C;
    const startMs = riseMs - 15 * 60_000;
    const endMs = setMs + 15 * 60_000;
    const positions = [];
    for (let t = startMs; t <= endMs; t += 60_000) {
      const date = new Date(t);
      let pv;
      try {
        pv = propagate(satrec, date);
      } catch {
        continue;
      }
      const pos = pv && pv.position;
      if (!pos || typeof pos === 'boolean') continue;
      const ecf = eciToEcf(pos, gstime(date));
      if (![ecf.x, ecf.y, ecf.z].every(Number.isFinite)) continue;
      positions.push(new Cartesian3(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000));
    }
    if (positions.length < 2) return;
    trackEntities.push(
      viewer.entities.add({
        polyline: {
          positions,
          width: 2,
          material: Color.fromCssColorString('#7CFFB2').withAlpha(0.9),
        },
      }),
    );
  }

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function startCountdown() {
    stopCountdown();
    if (!currentBest) return;
    const tick = () => {
      const now = Date.now();
      const { name, pass } = currentBest;
      if (now < pass.riseMs) {
        status.innerHTML = '';
        status.appendChild(
          el(
            'div',
            { style: 'font-size:15px;color:#7CFFB2;' },
            `👁 EYES ON in ${formatCountdown(pass.riseMs - now)}`,
          ),
        );
        status.appendChild(
          el(
            'div',
            {},
            `${name} — rises ${formatUtc(pass.riseMs)}, peak ${pass.maxElevDeg.toFixed(0)}° at ${formatUtc(pass.maxElevMs)}`,
          ),
        );
      } else if (now <= pass.setMs) {
        status.innerHTML = '';
        status.appendChild(
          el(
            'div',
            { style: 'font-size:15px;color:#ffd97a;' },
            '👁 OVERHEAD NOW',
          ),
        );
        status.appendChild(
          el('div', {}, `${name} — sets ${formatUtc(pass.setMs)}`),
        );
      } else {
        status.textContent = 'Pass complete — searching for the next one…';
        stopCountdown();
        runSearch();
      }
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  async function runSearch() {
    const lat = Number.parseFloat(latInput.value);
    const lon = Number.parseFloat(lonInput.value);
    if (
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180
    ) {
      status.textContent =
        'Enter a valid latitude (−90…90) and longitude (−180…180), or pick a point on the globe.';
      return;
    }
    observer = { lat, lon };
    stopCountdown();
    clearTrack();
    currentBest = null;
    findBtn.disabled = true;
    try {
      status.textContent = 'Fetching CelesTrak TLEs…';
      const res = await fetch(TLE_GROUP_URL, {
        headers: { accept: 'text/plain' },
      });
      if (!res.ok) throw new Error(`TLE feed HTTP ${res.status}`);
      const text = await res.text();
      const all = parseTleText(text);
      const imaging = all.filter((t) => isImagingCandidate(t.name));
      if (!imaging.length)
        throw new Error('no imaging candidates in TLE group');
      const candidates = [];
      for (const t of imaging) {
        try {
          candidates.push({
            name: t.name,
            satrec: twoline2satrec(t.line1, t.line2),
          });
        } catch {}
      }
      status.textContent = `Scanning ${candidates.length} imaging candidates over ${HORIZON_HOURS} h…`;
      const best = await findEarliestPass(
        candidates,
        lat,
        lon,
        Date.now(),
        (done, total) => {
          status.textContent = `Scanning ${done}/${total} imaging candidates…`;
        },
      );
      if (!best) {
        status.textContent = `No imaging overpass above ${MIN_ELEV_DEG}° in the next ${HORIZON_HOURS} h. Try a longer horizon or another point.`;
        return;
      }
      currentBest = best;
      await drawGroundTrack(
        best.pass && candidates.find((c) => c.name === best.name)?.satrec,
        best.pass.riseMs,
        best.pass.setMs,
      );
      startCountdown();
    } catch (error) {
      status.textContent = `Overpass search failed: ${error?.message ?? error}`;
    } finally {
      findBtn.disabled = false;
    }
  }
  findBtn.addEventListener('click', runSearch);

  const pickBtn = el(
    'button',
    {
      style:
        'margin:2px;padding:5px 9px;border-radius:20px;border:1px solid rgba(120,180,255,.35);' +
        'background:rgba(30,45,70,.6);color:#dfe9ff;cursor:pointer;font-size:11px;',
      'aria-pressed': 'false',
    },
    '📍 pick on globe',
  );

  async function setPicking(next) {
    picking = next;
    pickBtn.setAttribute('aria-pressed', String(picking));
    pickBtn.style.background = picking
      ? 'rgba(90,160,255,.35)'
      : 'rgba(30,45,70,.6)';
    if (picking && viewer) {
      try {
        const C = await import('cesium');
        const handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction((movement) => {
          const cartesian = viewer.camera.pickEllipsoid(
            movement.position,
            C.Ellipsoid.WGS84,
          );
          if (cartesian) {
            const carto = C.Cartographic.fromCartesian(cartesian);
            latInput.value = ((carto.latitude * 180) / Math.PI).toFixed(3);
            lonInput.value = ((carto.longitude * 180) / Math.PI).toFixed(3);
            status.textContent = `Target set: ${latInput.value}, ${lonInput.value} — hit "Find next eyes-on".`;
          }
          setPicking(false);
        }, C.ScreenSpaceEventType.LEFT_CLICK);
        clickHandler = handler;
      } catch {
        setPicking(false);
      }
    } else if (clickHandler) {
      try {
        clickHandler.destroy();
      } catch {}
      clickHandler = null;
    }
  }
  pickBtn.addEventListener('click', () => setPicking(!picking));

  const centerBtn = viewer
    ? (() => {
        const b = el(
          'button',
          {
            style:
              'margin:2px;padding:5px 9px;border-radius:20px;border:1px solid rgba(120,180,255,.35);' +
              'background:rgba(30,45,70,.6);color:#dfe9ff;cursor:pointer;font-size:11px;',
          },
          '◎ use map center',
        );
        b.addEventListener('click', async () => {
          try {
            const C = await import('cesium');
            const carto = viewer.camera.positionCartographic;
            latInput.value = C.Math.toDegrees(carto.latitude).toFixed(3);
            lonInput.value = C.Math.toDegrees(carto.longitude).toFixed(3);
          } catch {}
        });
        return b;
      })()
    : null;

  if (dock) {
    section = el('div', { style: 'margin-top:10px;' });
    section.appendChild(
      el(
        'div',
        {
          style:
            'font-size:10px;letter-spacing:.12em;color:#8aa4d6;margin-bottom:4px;font-weight:600;',
        },
        t('feature.eyesOn'),
      ),
    );
    const row = el('div', {
      style: 'display:flex;gap:4px;align-items:center;flex-wrap:wrap;',
    });
    row.appendChild(latInput);
    row.appendChild(lonInput);
    if (viewer) row.appendChild(pickBtn);
    if (centerBtn) row.appendChild(centerBtn);
    section.appendChild(row);
    section.appendChild(findBtn);
    section.appendChild(status);
    section.appendChild(
      el(
        'div',
        { style: 'font-size:10px;color:#7288b3;margin-top:4px;' },
        `"Imaging-capable" = heuristic name match over CelesTrak's resource group. ` +
          `"Eyes on" = elevation ≥ ${MIN_ELEV_DEG}°. SGP4-derived, ${HORIZON_HOURS} h horizon.`,
      ),
    );
    dock.appendChild(section);
  } else {
    const floating = el('div', {
      style:
        'position:fixed;right:12px;top:144px;z-index:9990;background:rgba(8,12,20,.88);' +
        'border:1px solid rgba(120,180,255,.25);border-radius:10px;padding:10px;color:#dfe9ff;' +
        'font:11px/1.5 system-ui,sans-serif;max-width:250px;',
    });
    floating.appendChild(
      el('div', { style: 'font-weight:600;margin-bottom:6px;' }, '👁 EYES-ON'),
    );
    const row = el('div', { style: 'display:flex;gap:4px;margin-bottom:6px;' });
    row.appendChild(latInput);
    row.appendChild(lonInput);
    floating.appendChild(row);
    floating.appendChild(findBtn);
    floating.appendChild(status);
    document.body.appendChild(floating);
    section = floating;
  }

  return () => {
    stopCountdown();
    clearTrack();
    if (clickHandler) {
      try {
        clickHandler.destroy();
      } catch {}
      clickHandler = null;
    }
    if (section) section.remove();
  };
}
