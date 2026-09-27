/**
 * Wave 5 — global quake aggregation globe layer (frontier).
 *
 * Renders /api/quakes (USGS + JMA + BMKG + GeoNet NZ + EMSC, cross-catalog
 * deduped) as magnitude-sized, magnitude-colored globe points with
 * click-for-details. Points sit slightly above the surface by depth band so
 * deep quakes are still visible.
 *
 * This is the ONLY file in this feature that imports Cesium; model.js stays
 * testable in plain Node.
 *
 * Relation to the existing USGS-only Earthquakes layer
 * (src/layers/earthquakes/): that layer shows the USGS 24h feed alone with
 * its own cohort/overlay treatment. This one aggregates five catalogs and
 * merges duplicate reports of the same event — the legend says so.
 *
 * Fail-soft: a dead /api/quakes leaves an honest empty state, never a throw.
 */
import * as Cesium from 'cesium';
import {
  fetchQuakes,
  magColor,
  magSize,
  depthBand,
  quakeLabel,
  quakeAge,
  sourcesSummary,
  sortQuakesByMag,
  escapeHtml,
  SOURCE_LABELS,
} from './model.js';

const API = '/api/quakes';
const REFRESH_MS = 5 * 60_000;
const MAX_POINTS = 500;

export function init({ viewer, mount, chip, trackLayer, t } = {}) {
  try {
    if (!viewer || typeof document === 'undefined') return null;
    const T = typeof t === 'function' ? t : (k) => k;
    const ds = new Cesium.CustomDataSource('wave5-quakes');
    ds.show = false;
    viewer.dataSources.add(ds);

    let enabled = false;
    let destroyed = false;
    let refreshTimer = 0;
    let statusEl = null;
    let topEl = null;

    async function load() {
      if (destroyed || !enabled) return;
      try {
        const payload = await fetchQuakes();
        if (destroyed || !enabled) return;
        render(payload);
        updateStatus(payload);
      } catch (error) {
        updateStatus(null, error);
      }
    }

    function render(payload) {
      ds.entities.removeAll();
      const quakes = sortQuakesByMag(payload.quakes ?? []).slice(0, MAX_POINTS);
      for (const q of quakes) {
        if (!Number.isFinite(q.lat) || !Number.isFinite(q.lon)) continue;
        const color = Cesium.Color.fromCssColorString(magColor(q.mag));
        const size = magSize(q.mag);
        // depth offset keeps deep quakes visible above the surface point
        const height = Number.isFinite(q.depthKm) ? Math.min(300_000, 20_000 + q.depthKm * 1000 * 0.5) : 30_000;
        const position = Cesium.Cartesian3.fromDegrees(q.lon, q.lat, height);
        ds.entities.add({
          id: `wave5-quake:${q.id}`,
          position,
          point: new Cesium.PointGraphics({
            pixelSize: size,
            color: color.withAlpha(0.95),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
            outlineWidth: 1.5,
            heightReference: Cesium.HeightReference.NONE,
            disableDepthTestDistance: 1.0e12,
          }),
          label: Number.isFinite(q.mag) && q.mag >= 6
            ? new Cesium.LabelGraphics({
              text: `M${q.mag.toFixed(1)}`,
              font: '11px system-ui, sans-serif',
              fillColor: Cesium.Color.WHITE,
              outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              pixelOffset: new Cesium.Cartesian2(0, -(size / 2 + 4)),
            })
            : undefined,
          description:
            `<b>${escapeHtml(quakeLabel(q))}</b><br>` +
            `Time: ${escapeHtml(q.time ?? '—')} (${escapeHtml(quakeAge(q.time))})<br>` +
            `Magnitude: ${Number.isFinite(q.mag) ? escapeHtml(String(q.mag)) : '—'}<br>` +
            `Depth: ${Number.isFinite(q.depthKm) ? escapeHtml(`${q.depthKm} km`) : '—'} ` +
            `(${escapeHtml(depthBand(q.depthKm))})<br>` +
            `Sources: ${escapeHtml(sourcesSummary(q.sources))}<br>` +
            `<span style="opacity:.75">Aggregated from five public catalogs; ` +
            `duplicate reports of one event are merged.</span>`,
        });
      }
    }

    function updateStatus(payload, error) {
      if (!statusEl) return;
      if (error) {
        statusEl.textContent = `quake feed unavailable (${String(error.message ?? error).slice(0, 60)})`;
        statusEl.style.color = '#ff8a8a';
        return;
      }
      statusEl.style.color = '#8aa4d6';
      const live = Object.entries(payload?.sources ?? {})
        .filter(([, s]) => s.ok)
        .map(([k]) => SOURCE_LABELS[k] ?? k);
      statusEl.textContent =
        `${payload?.count ?? 0} quakes · ${live.length}/5 catalogs live` +
        (live.length ? ` (${live.join(', ')})` : '') +
        ` · ${quakeAge(payload?.generatedAt ?? '')}`;
      if (topEl) {
        const top = sortQuakesByMag(payload?.quakes ?? []).slice(0, 3);
        topEl.innerHTML = top.length
          ? top
              .map(
                (q) =>
                  `<div>🌋 ${escapeHtml(quakeLabel(q))} ` +
                  `<span style="opacity:.65">(${escapeHtml(quakeAge(q.time))})</span></div>`,
              )
              .join('')
          : '<div style="opacity:.6">no quakes in window</div>';
      }
    }

    function setEnabled(on) {
      enabled = on;
      ds.show = on;
      if (on) {
        void load();
        refreshTimer = setInterval(load, REFRESH_MS);
      } else {
        clearInterval(refreshTimer);
      }
    }

    if (mount && typeof chip === 'function') {
      try {
        statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:10px;color:#8aa4d6;margin:2px 0 4px;';
        statusEl.textContent = 'loading quake catalogs…';
        mount.appendChild(statusEl);
        topEl = document.createElement('div');
        topEl.style.cssText = 'font-size:10px;color:#c8d6f5;margin:2px 0;line-height:1.5;';
        mount.appendChild(topEl);
        const apply = (on) => setEnabled(on);
        if (typeof trackLayer === 'function') {
          const tracked = trackLayer('quakes', {
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
          });
          mount.appendChild(
            chip(T('feature.quakes') || 'Global quakes', (on) =>
              on ? tracked.show() : tracked.hide(), false),
          );
        } else {
          mount.appendChild(chip(T('feature.quakes') || 'Global quakes', apply, false));
        }
        const legend = document.createElement('div');
        legend.style.cssText = 'font-size:10px;color:#8aa4d6;margin-top:4px;line-height:1.6;';
        legend.innerHTML =
          '<span style="color:#4dd07d">●</span> &lt;M4 · ' +
          '<span style="color:#ffd54d">●</span> M4–5 · ' +
          '<span style="color:#ff9f43">●</span> M5–6 · ' +
          '<span style="color:#ff5a5a">●</span> M6–7 · ' +
          '<span style="color:#c44dff">●</span> M7+<br>' +
          '<span style="opacity:.75">Point size ∝ magnitude. Aggregates USGS, JMA, ' +
          'BMKG, GeoNet NZ, EMSC; duplicate reports of one event are merged. ' +
          'The Earthquakes layer shows the USGS feed alone.</span>';
        mount.appendChild(legend);
      } catch {
        /* dock UI optional */
      }
    }

    return function destroy() {
      destroyed = true;
      setEnabled(false);
      try {
        viewer.dataSources.remove(ds, true);
      } catch {
        /* already gone */
      }
    };
  } catch (error) {
    console.warn('[wave5 quakes] init failed:', error);
    return null;
  }
}
