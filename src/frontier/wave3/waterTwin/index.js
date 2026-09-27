/**
 * Water twin — frontend (Wave 3, Track 1c, item 1.10).
 *
 * Fail-soft mount: fetches /api/water-twin, renders reservoir storage bars
 * (% of curated capacity) and river gage-height vs flood-stage bands, with
 * globe markers for rivers at/above action stage. All data keyless and
 * server-proxied (CDEC/NWIS CORS is unreliable from browsers).
 *
 * Public surface:
 *   initWaterTwin({ viewer, fetchImpl, mount }) -> { destroy }
 *   createWaterTwinSection() -> { element, update(payload) }
 */
import {
  bandLabel,
  bandColor,
  reservoirBand,
  reservoirBandColor,
  reservoirBandLabel,
  summarizeTwin,
} from './twin.js';
import { fetchPrecipitation } from './precip.js';
import { RIVERS } from '../../../../shared/waterTwinRegistry.js';

const API = '/api/water-twin';
const REFRESH_MS = 30 * 60_000;

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (text) node.textContent = text;
  return node;
}

function bar(pct, color) {
  const wrap = el('div', {
    style: 'height:8px;border-radius:4px;background:rgba(255,255,255,.12);margin-top:4px;overflow:hidden;',
  });
  wrap.appendChild(el('div', {
    style: `height:100%;width:${Math.max(0, Math.min(100, pct))}%;background:${color};`,
  }));
  return wrap;
}

function reservoirRow(r) {
  const row = el('div', { style: 'margin:6px 0;font-size:11px;' });
  const band = reservoirBand(r.pctFull);
  row.appendChild(
    el('div', {}, `${r.name} — ${r.pctFull != null ? `${r.pctFull}% full` : reservoirBandLabel(band)}`),
  );
  if (r.pctFull != null) row.appendChild(bar(r.pctFull, reservoirBandColor(band)));
  return row;
}

function riverRow(r) {
  const row = el('div', {
    style: `margin:6px 0;font-size:11px;border-left:3px solid ${bandColor(r.band)};padding-left:6px;`,
  });
  const gage = r.gageFt != null ? `${r.gageFt.toFixed(1)} ft` : '—';
  row.appendChild(el('div', {}, `${r.name} — ${bandLabel(r.band)}`));
  row.appendChild(
    el('div', { style: 'color:#9fc2ff;' },
      `gage ${gage} · flood stage ${r.floodStageFt} ft${r.flowCfs != null ? ` · ${Math.round(r.flowCfs).toLocaleString()} cfs` : ''}`),
  );
  return row;
}

export function createWaterTwinSection() {
  const element = el('div', {});
  const summary = el('div', { style: 'font-size:11px;color:#9fc2ff;margin-bottom:4px;' }, 'checking…');
  const precipRow = el('div', { style: 'font-size:10px;color:#7d8fb3;margin-bottom:2px;' }, '🌧 radar: checking…');
  const resWrap = el('div', {});
  const rivWrap = el('div', {});
  element.append(summary, precipRow, resWrap, rivWrap);

  return {
    element,
    /** Precipitation overlay state from precip.js (fail-soft). */
    setPrecip(precip) {
      if (precip?.available) {
        const when = new Date(precip.frameTime * 1000).toISOString().replace('T', ' ').slice(0, 16);
        precipRow.textContent = `🌧 radar frame ${when} UTC — observed precip, not a forecast`;
      } else {
        precipRow.textContent = '🌧 radar unavailable';
      }
    },
    update(payload) {
      resWrap.textContent = '';
      rivWrap.textContent = '';
      const s = summarizeTwin(payload);
      const bits = [];
      if (s.driestReservoir) bits.push(`driest: ${s.driestReservoir.name} ${s.driestReservoir.pctFull}%`);
      if (s.worstRiver && s.worstRiver.band !== 'normal' && s.worstRiver.band !== 'unknown')
        bits.push(`worst river: ${s.worstRiver.name} (${bandLabel(s.worstRiver.band)})`);
      summary.textContent = bits.length ? bits.join(' · ') : 'all gauges normal';
      if (payload?.stale) summary.textContent += ' (cached)';

      resWrap.appendChild(el('div', { style: 'font-size:10px;letter-spacing:.1em;color:#8aa4d6;margin-top:6px;' }, 'RESERVOIRS — % OF CAPACITY'));
      for (const r of payload?.reservoirs ?? []) resWrap.appendChild(reservoirRow(r));
      rivWrap.appendChild(el('div', { style: 'font-size:10px;letter-spacing:.1em;color:#8aa4d6;margin-top:6px;' }, 'RIVERS — GAGE VS FLOOD STAGE'));
      for (const r of payload?.rivers ?? []) rivWrap.appendChild(riverRow(r));
      rivWrap.appendChild(
        el('div', { style: 'font-size:10px;color:#7d8fb3;margin-top:4px;' },
          'Bands vs curated reference stages — not official NWS categories. Capacities are approximate.'),
      );
    },
    fail(reason) {
      summary.textContent = `Water twin unavailable (${reason ?? 'upstream down'}).`;
    },
  };
}

/** Cesium markers for rivers at/above action stage. Lazy Cesium import. */
async function addGlobeMarkers(viewer, rivers) {
  if (!viewer?.entities) return () => {};
  const { Color, Cartesian3 } = await import('cesium');
  const entities = [];
  for (const r of rivers ?? []) {
    if (r.band === 'normal' || r.band === 'unknown') continue;
    const geo = riverGeo(r.site);
    if (!geo) continue;
    entities.push(
      viewer.entities.add({
        position: Cartesian3.fromDegrees(geo.lon, geo.lat, 100000),
        point: {
          pixelSize: 12,
          color: Color.fromCssColorString(bandColor(r.band)),
          outlineColor: Color.WHITE,
          outlineWidth: 2,
        },
        description: `${r.name}: ${bandLabel(r.band)} — gage ${r.gageFt ?? '—'} ft vs flood ${r.floodStageFt} ft`,
      }),
    );
  }
  return () => { for (const e of entities) viewer.entities.remove(e); };
}

/** Approximate marker positions for the curated river gauges (from the registry). */
function riverGeo(site) {
  const r = RIVERS.find((x) => x.site === site);
  return r ? { lat: r.lat, lon: r.lon } : null;
}

/** RainViewer radar as a translucent Cesium imagery layer. Lazy Cesium import. */
async function addRadarLayer(viewer, tileTemplate) {
  if (!viewer?.imageryLayers || !tileTemplate) return () => {};
  const { UrlTemplateImageryProvider } = await import('cesium');
  const provider = new UrlTemplateImageryProvider({
    url: tileTemplate,
    credit: 'Radar: RainViewer (observed reflectivity)',
    maximumLevel: 10,
  });
  const layer = viewer.imageryLayers.addImageryProvider(provider);
  try { layer.alpha = 0.55; } catch {}
  return () => { try { viewer.imageryLayers.remove(layer); } catch {} };
}

export function initWaterTwin({ viewer = null, fetchImpl = fetch, mount = null } = {}) {
  const section = createWaterTwinSection();
  if (mount) mount(section.element);
  let timer = null;
  let removeMarkers = null;
  let removeRadar = null;
  let stopped = false;

  async function refresh() {
    try {
      const res = await fetchImpl(API);
      if (!res.ok) throw new Error(`http_${res.status}`);
      const payload = await res.json();
      if (stopped) return;
      section.update(payload);
      try {
        const precip = await fetchPrecipitation({ fetchImpl });
        if (stopped) return;
        section.setPrecip(precip);
        if (viewer) {
          try { removeRadar?.(); } catch {}
          removeRadar = await addRadarLayer(viewer, precip.available ? precip.tileTemplate : null);
        }
      } catch {}
      if (viewer) {
        try { removeMarkers?.(); } catch {}
        removeMarkers = await addGlobeMarkers(viewer, payload.rivers ?? []);
      }
    } catch (error) {
      if (!stopped) section.fail(error?.message);
    }
  }

  refresh();
  timer = setInterval(refresh, REFRESH_MS);
  return {
    destroy() {
      stopped = true;
      if (timer) clearInterval(timer);
      try { removeMarkers?.(); } catch {}
      try { removeRadar?.(); } catch {}
      section.element.remove();
    },
  };
}
