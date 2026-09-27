/**
 * Wave 3 Track 2c / 2.12 — Feodo Tracker defensive threat-intel markers.
 *
 * init({ viewer }) mounts a fail-soft Cesium layer: country heat markers for
 * the abuse.ch Feodo Tracker blocklist (defensive display of a public list;
 * no scanning or probing of any kind). Red = at least one C2 currently
 * online in that country. Click a marker for the per-country breakdown.
 */
import { mountPollingLayer, escapeHtml } from '../common/layer.js';
import { countryMarkers, markerSize, markerColorCss } from './model.js';
import { createFeodoSource } from './source.js';

export * from './model.js';
export { createFeodoSource } from './source.js';

const REFRESH_MS = 5 * 60_000;

export function init({ viewer, apiPath = '/api/feodo' } = {}) {
  try {
    const { init: mount } = mountPollingLayer({
      name: 'wave3-feodo',
      apiPath,
      intervalMs: REFRESH_MS,
      render({ dataSource, data, Cesium }) {
        dataSource.entities.removeAll();
        const markers = countryMarkers(data.byCountry, data.entries);
        for (const m of markers) {
          const color = Cesium.Color.fromCssColorString(markerColorCss(m.online));
          const famRows = m.malware
            .map(([fam, n]) => `<tr><td>${escapeHtml(fam)}</td><td>${n}</td></tr>`)
            .join('');
          dataSource.entities.add({
            id: `feodo:${m.iso}`,
            position: Cesium.Cartesian3.fromDegrees(m.lon, m.lat, 20000),
            point: {
              pixelSize: markerSize(m.count),
              color: color.withAlpha(0.85),
              outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
              outlineWidth: 1,
            },
            label: {
              text: `${m.iso} · ${m.count}`,
              font: '10px system-ui, sans-serif',
              fillColor: Cesium.Color.WHITE.withAlpha(0.85),
              pixelOffset: new Cesium.Cartesian2(10, -8),
              scaleByDistance: new Cesium.NearFarScalar(2e6, 1, 3e7, 0),
            },
            description:
              `<h3>${m.iso} — Feodo Tracker blocklist</h3>` +
              `<p>${m.count} listed C2 IPs (${m.online} currently online). ` +
              `Country-level marker; positions are approximate country centroids.</p>` +
              (famRows ? `<table><tr><th>family</th><th>IPs</th></tr>${famRows}</table>` : '') +
              `<p style="opacity:.7">Threat intel © abuse.ch — defensive display only.</p>`,
          });
        }
      },
    });
    return mount({ viewer });
  } catch (error) {
    console.warn('[wave3:feodo] init failed:', error?.message || error);
    return null;
  }
}
