/**
 * Radiation map client (wave3 sci-fi B #4) — live background-radiation dots.
 *
 * Reads /api/radiation (Safecast via server proxy), renders one dot per
 * decluttered cell colored by dose band, refreshes every 10 minutes.
 * init(viewer, { mount }) → { destroy }. Fail-soft throughout.
 */
import * as Cesium from 'cesium';
import {
  BAND_COLORS,
  BAND_LABELS,
  doseBand,
  validateRadiationPayload,
  declutterByCell,
} from './model.js';

const REFRESH_MS = 10 * 60_000;

export function init(viewer, { mount = null, fetchImpl = fetch } = {}) {
  if (!viewer || typeof document === 'undefined') return null;
  let destroyed = false;
  let on = false;
  let timer = null;
  const entities = viewer.entities;
  const owned = [];

  function clear() {
    for (const e of owned.splice(0)) {
      try { entities.remove(e); } catch { /* best effort */ }
    }
  }

  async function refresh() {
    if (!on || destroyed) return;
    try {
      const res = await fetchImpl('/api/radiation');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const check = validateRadiationPayload(payload);
      if (!check.ok) throw new Error(`bad payload: ${check.reason}`);
      if (payload.unavailable) {
        note(`Radiation feed unavailable (${payload.reason ?? 'unknown'}).`);
        return;
      }
      clear();
      const dots = declutterByCell(payload.points);
      for (const p of dots) {
        const band = doseBand(p.valueUsvH);
        try {
          owned.push(
            entities.add({
              position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 6000),
              point: {
                pixelSize: band === 'high' ? 7 : 4,
                color: Cesium.Color.fromCssColorString(BAND_COLORS[band]).withAlpha(0.85),
                outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
                outlineWidth: 1,
              },
              description:
                `${p.valueUsvH.toFixed(3)} µSv/h (${p.unit})` +
                (p.capturedAt ? ` — captured ${p.capturedAt}` : ''),
            }),
          );
        } catch { /* skip bad point */ }
      }
      const when = payload.fetchedAt ? new Date(payload.fetchedAt).toISOString() : 'unknown';
      note(
        `${dots.length} sensors${payload.stale ? ' (stale cache)' : ''} — ` +
        `fetched ${when}. Safecast volunteer network.`,
      );
    } catch (error) {
      console.warn('[radiation]', error);
      note(`Radiation feed error: ${error?.message ?? error}`);
    }
  }

  // — UI —
  const panel = document.createElement('div');
  panel.style.cssText =
    'margin-top:8px;padding:8px;border-radius:8px;background:rgba(10,18,32,.7);' +
    'border:1px solid rgba(120,180,255,.2);font:12px/1.5 system-ui,sans-serif;color:#dfe9ff;';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:10px;letter-spacing:.12em;color:#8aa4d6;font-weight:600;';
  title.textContent = '☢️ RADIATION';
  const toggle = document.createElement('button');
  toggle.textContent = '☢️ radiation dots';
  toggle.setAttribute('aria-pressed', 'false');
  toggle.style.cssText =
    'margin:2px;padding:5px 9px;border-radius:20px;border:1px solid rgba(120,180,255,.35);' +
    'background:rgba(30,45,70,.6);color:#dfe9ff;cursor:pointer;font-size:11px;';
  const noteEl = document.createElement('div');
  noteEl.style.cssText = 'color:#9fb4dd;font-size:10px;margin-top:4px;min-height:16px;';
  const legend = document.createElement('div');
  legend.style.cssText = 'color:#7d8fb5;font-size:9px;margin-top:4px;line-height:1.6;';
  legend.innerHTML = Object.entries(BAND_LABELS)
    .map(([k, v]) => `<span style="color:${BAND_COLORS[k]}">●</span> ${v}`)
    .join('<br>');
  const honesty = document.createElement('div');
  honesty.style.cssText = 'color:#7d8fb5;font-size:9px;margin-top:4px;line-height:1.4;';
  honesty.textContent =
    'Volunteer sensor readings, not a calibrated monitoring network. ' +
    'uRadMonitor and OpenRadiation keyless paths are retired (auth required); ' +
    'this layer uses Safecast. CPM→µSv/h conversion is approximate.';

  function note(text) { noteEl.textContent = text; }

  toggle.addEventListener('click', () => {
    on = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', String(on));
    toggle.style.background = on ? 'rgba(90,160,255,.35)' : 'rgba(30,45,70,.6)';
    if (on) {
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
    } else {
      if (timer) { clearInterval(timer); timer = null; }
      clear();
      noteEl.textContent = '';
    }
  });

  panel.append(title, toggle, noteEl, legend, honesty);
  (mount ?? document.body).appendChild(panel);

  return {
    refresh,
    destroy() {
      destroyed = true;
      if (timer) clearInterval(timer);
      clear();
      panel.remove();
    },
  };
}

export { BAND_COLORS, BAND_LABELS, validateRadiationPayload, declutterByCell };
