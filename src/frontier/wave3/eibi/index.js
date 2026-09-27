/**
 * Wave 3 Track 2c / 2.15 — EiBi shortwave "on air now" markers.
 *
 * init({ viewer }) mounts a fail-soft Cesium layer: one marker per country
 * with HF broadcasters currently on the air, sized by station count. Click
 * a marker for the live station/frequency/language/target list — the same
 * parsed shape that feeds W8's shortwave oracle (see INTEGRATION.md).
 *
 * Honesty note: the EiBi CSV carries no transmitter coordinates, so these
 * are COUNTRY-level markers (approximate centroids), never site pins.
 */
import { mountPollingLayer, escapeHtml } from '../common/layer.js';
import { aggregateOnAir, markerSize } from './model.js';
import { createEibiSource } from './source.js';

export * from './model.js';
export { createEibiSource } from './source.js';

const REFRESH_MS = 60_000; // minute-precision "on air now"

export function init({ viewer, apiPath = '/api/eibi' } = {}) {
  try {
    const { init: mount } = mountPollingLayer({
      name: 'wave3-eibi',
      apiPath,
      intervalMs: REFRESH_MS,
      render({ dataSource, data, Cesium }) {
        dataSource.entities.removeAll();
        const { markers } = aggregateOnAir(data.onAir);
        for (const m of markers) {
          const rows = m.stations
            .map(
              (s) =>
                `<tr><td>${s.freqKhz}</td><td>${s.band}</td><td>${escapeHtml(s.station)}</td>` +
                `<td>${escapeHtml(s.lang) || '–'}</td><td>${escapeHtml(s.target) || '–'}</td>` +
                `<td>${escapeHtml(s.site) || '–'}</td></tr>`,
            )
            .join('');
          dataSource.entities.add({
            id: `eibi:${m.iso}`,
            position: Cesium.Cartesian3.fromDegrees(m.lon, m.lat, 20000),
            point: {
              pixelSize: markerSize(m.count),
              color: Cesium.Color.CYAN.withAlpha(0.9),
              outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
              outlineWidth: 1,
            },
            label: {
              text: `${m.iso} · ${m.count} on air`,
              font: '10px system-ui, sans-serif',
              fillColor: Cesium.Color.WHITE.withAlpha(0.85),
              pixelOffset: new Cesium.Cartesian2(10, -8),
              scaleByDistance: new Cesium.NearFarScalar(2e6, 1, 3e7, 0),
            },
            description:
              `<h3>${m.iso} — HF broadcasters on air now (${m.count})</h3>` +
              `<table><tr><th>kHz</th><th>band</th><th>station</th><th>lang</th><th>target</th><th>site</th></tr>` +
              `${rows}</table>` +
              `<p style="opacity:.7">Country-level marker (no site coords in EiBi data). ` +
              `Schedules © Eike Bierwirth / EiBi (via /api/eibi).</p>`,
          });
        }
      },
    });
    return mount({ viewer });
  } catch (error) {
    console.warn('[wave3:eibi] init failed:', error?.message || error);
    return null;
  }
}
