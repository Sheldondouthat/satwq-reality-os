/**
 * Wave 3 Track 2c / 2.13 — GDELT planetary-attention heat bubbles.
 *
 * init({ viewer }) mounts a fail-soft Cesium layer: clustered news-mention
 * bubbles from the GDELT GKG v1 feed. Bubble size = mention volume,
 * color = average article tone (red negative, green positive, gold neutral).
 * Click a bubble for the top place names and article links.
 */
import { mountPollingLayer, escapeHtml } from '../common/layer.js';
import { clusterMentions, bubbleSize, toneColorCss } from './model.js';
import { createGdeltSource } from './source.js';

export * from './model.js';
export { createGdeltSource } from './source.js';

const REFRESH_MS = 15 * 60_000;
const MAX_BUBBLES = 220;

export function init({ viewer, apiPath = '/api/gdelt' } = {}) {
  try {
    const { init: mount } = mountPollingLayer({
      name: 'wave3-gdelt',
      apiPath,
      intervalMs: REFRESH_MS,
      render({ dataSource, data, Cesium }) {
        dataSource.entities.removeAll();
        const bubbles = clusterMentions(data.mentions).slice(0, MAX_BUBBLES);
        for (const b of bubbles) {
          const color = Cesium.Color.fromCssColorString(toneColorCss(b.avgTone));
          const nameList = b.names.map((n) => `<li>${escapeHtml(n)}</li>`).join('');
          const urlList = b.urls
            .map((u) => `<li><a href="${escapeHtml(u)}" target="_blank" rel="noopener">article</a></li>`)
            .join('');
          dataSource.entities.add({
            id: `gdelt:${b.lon.toFixed(2)}:${b.lat.toFixed(2)}`,
            position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat, 20000),
            point: {
              pixelSize: bubbleSize(b.count),
              color: color.withAlpha(0.75),
              outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
              outlineWidth: 1,
            },
            label: {
              text: `${b.count}`,
              font: '10px system-ui, sans-serif',
              fillColor: Cesium.Color.WHITE.withAlpha(0.9),
              pixelOffset: new Cesium.Cartesian2(10, -8),
              scaleByDistance: new Cesium.NearFarScalar(2e6, 1, 3e7, 0),
            },
            description:
              `<h3>Planetary attention — ${b.count} mentions</h3>` +
              (b.avgTone != null ? `<p>Average tone: <b>${b.avgTone}</b></p>` : '') +
              (nameList ? `<ul>${nameList}</ul>` : '') +
              (urlList ? `<ul>${urlList}</ul>` : '') +
              `<p style="opacity:.7">Geolocated news mentions © GDELT Project (v1, via /api/gdelt).</p>`,
          });
        }
      },
    });
    return mount({ viewer });
  } catch (error) {
    console.warn('[wave3:gdelt] init failed:', error?.message || error);
    return null;
  }
}
